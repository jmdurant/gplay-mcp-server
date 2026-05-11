import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

const REPORTING_BASE_URL =
  'https://playdeveloperreporting.googleapis.com/v1beta1';

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface MetricValue {
  metric: string;
  decimalValue?: { value: string };
  longValue?: { value: string };
}

interface MetricRow {
  startTime?: CalendarDate;
  endTime?: CalendarDate;
  metrics: MetricValue[];
}

interface MetricQueryResponse {
  rows?: MetricRow[];
}

interface ErrorIssue {
  name: string;
  type?: string;
  cause?: string;
  location?: string;
  errorReportCount?: string;
  distinctUsers?: string;
  lastErrorReportTime?: string;
  sampleErrorReports?: string[];
}

interface ErrorIssuesSearchResponse {
  errorIssues?: ErrorIssue[];
  nextPageToken?: string;
}

/// UTC calendar date `n` days before today, suitable for the Reporting API's
/// interval fields (which are calendar dates, not timestamps).
function daysAgo(n: number): CalendarDate {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/// Run a metric-set query, and if Google rejects with a "current freshness
/// YYYY-MM-DD" error (the metric data is lagged by several days and Google
/// won't accept an endTime past freshness), parse that date and retry with
/// it as the endTime. Returns the (possibly clamped) actual endTime used so
/// callers can surface it.
async function queryMetricWithFreshnessFallback(
  client: GooglePlayClient,
  path: string,
  body: { timelineSpec: { endTime: CalendarDate; [k: string]: unknown }; [k: string]: unknown },
): Promise<{ response: MetricQueryResponse; endTimeUsed: CalendarDate }> {
  try {
    const response = await client.request<MetricQueryResponse>(path, {
      method: 'POST',
      body,
      baseUrl: REPORTING_BASE_URL,
    });
    return { response, endTimeUsed: body.timelineSpec.endTime };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /current freshness (\d{4})-(\d{2})-(\d{2})/i.exec(msg);
    if (!m) throw e;
    const fresh: CalendarDate = {
      year: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      day: parseInt(m[3], 10),
    };
    const patched = {
      ...body,
      timelineSpec: { ...body.timelineSpec, endTime: fresh },
    };
    const response = await client.request<MetricQueryResponse>(path, {
      method: 'POST',
      body: patched,
      baseUrl: REPORTING_BASE_URL,
    });
    return { response, endTimeUsed: fresh };
  }
}

/// Pretty-print a metric value that's a rate (0..1 decimal).
function formatRate(rows: MetricRow[], metric: string): string {
  const values = rows
    .flatMap(r => r.metrics)
    .filter(m => m.metric === metric && m.decimalValue?.value)
    .map(m => parseFloat(m.decimalValue!.value));
  if (values.length === 0) return 'n/a';
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `${(avg * 100).toFixed(3)}%`;
}

export function registerReportingTools(
  server: McpServer,
  client: GooglePlayClient,
) {
  server.tool(
    'get_app_health_summary',
    'Query the Play Developer Reporting API for crash rate + ANR rate over ' +
      'the last N days. Returns daily-averaged percentages. Empty data is ' +
      'normal for apps that just shipped or have low install volume — the ' +
      'tool surfaces that explicitly rather than failing. ' +
      'Requires the Reporting API to be enabled in Google Cloud Console for ' +
      'the project hosting the service account.',
    {
      packageName: z.string().describe('Android package name'),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe('Look-back window in days (default: 28, max: 90)'),
    },
    async ({ packageName, days }) => {
      try {
        const window = days ?? 28;
        const startTime = daysAgo(window);
        // Optimistic endTime; the helper will clamp to Google's actual
        // metric freshness if it's lagging further behind.
        const endTime = daysAgo(1);

        const baseBody = {
          dimensions: [] as string[],
          timelineSpec: {
            aggregationPeriod: 'DAILY' as const,
            startTime,
            endTime,
          },
        };

        const { response: crash, endTimeUsed } = await queryMetricWithFreshnessFallback(
          client,
          `/apps/${packageName}/crashRateMetricSet:query`,
          { ...baseBody, metrics: ['crashRate'] },
        );

        // Reuse the resolved endTime for the ANR query so both metrics
        // cover the same window.
        const { response: anr } = await queryMetricWithFreshnessFallback(
          client,
          `/apps/${packageName}/anrRateMetricSet:query`,
          {
            ...baseBody,
            timelineSpec: { ...baseBody.timelineSpec, endTime: endTimeUsed },
            metrics: ['anrRate'],
          },
        );

        const crashRows = crash.rows ?? [];
        const anrRows = anr.rows ?? [];

        const hasData = crashRows.length > 0 || anrRows.length > 0;
        const endStr = `${endTimeUsed.year}-${String(endTimeUsed.month).padStart(2, '0')}-${String(endTimeUsed.day).padStart(2, '0')}`;
        const wasClamped =
          endTimeUsed.year !== endTime.year ||
          endTimeUsed.month !== endTime.month ||
          endTimeUsed.day !== endTime.day;

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `App health for ${packageName} ` +
                `(${window}-day window ending ${endStr}):\n\n` +
                `Crash rate: ${formatRate(crashRows, 'crashRate')} ` +
                `(${crashRows.length} day(s) of data)\n` +
                `ANR rate:   ${formatRate(anrRows, 'anrRate')} ` +
                `(${anrRows.length} day(s) of data)\n\n` +
                (wasClamped
                  ? `Note: end date clamped to ${endStr} — Google's metric ` +
                    `aggregation lags real-time by several days.\n\n`
                  : '') +
                (hasData
                  ? "Data lags by several days — metrics aren't real-time."
                  : 'No data returned. Common reasons: app has very low ' +
                    'install volume, app was just shipped, or the Reporting ' +
                    'API is not yet enabled for the project.'),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    'get_top_crashes',
    'Search the Play Developer Reporting API for top error issues ' +
      '(clusters of crashes, ANRs, or non-fatals) over a window. Ranked by ' +
      'report count. Use after_launch to triage what to fix first.',
    {
      packageName: z.string().describe('Android package name'),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe('Look-back window in days (default: 28, max: 90)'),
      issueType: z
        .enum(['CRASH', 'ANR', 'NON_FATAL'])
        .optional()
        .describe('Filter to one type. Default: all types'),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of issues to return (default 10)'),
    },
    async ({ packageName, days, issueType, pageSize }) => {
      try {
        const window = days ?? 28;
        const startTime = daysAgo(window);
        const endTime = daysAgo(0);

        const params: Record<string, string> = {
          pageSize: String(pageSize ?? 10),
          'interval.startTime.year': String(startTime.year),
          'interval.startTime.month': String(startTime.month),
          'interval.startTime.day': String(startTime.day),
          'interval.endTime.year': String(endTime.year),
          'interval.endTime.month': String(endTime.month),
          'interval.endTime.day': String(endTime.day),
        };
        if (issueType) {
          params['filter'] = `errorIssueType=${issueType}`;
        }

        const result = await client.request<ErrorIssuesSearchResponse>(
          `/apps/${packageName}/errorIssues:search`,
          {
            method: 'GET',
            params,
            baseUrl: REPORTING_BASE_URL,
          },
        );

        const issues = result.errorIssues ?? [];
        if (issues.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `No error issues for ${packageName} in the last ` +
                  `${window} days. Common reasons: app has very low install ` +
                  `volume, no crashes yet (good news), or the Reporting API ` +
                  `is not yet enabled for the project.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Top error issues for ${packageName} (last ${window} days):\n\n` +
                issues
                  .map(
                    (i, idx) =>
                      `${idx + 1}. [${i.type ?? '?'}] ${i.cause ?? i.location ?? '(no signature)'}\n` +
                      `   Reports: ${i.errorReportCount ?? '?'}, ` +
                      `Distinct users: ${i.distinctUsers ?? '?'}\n` +
                      `   Last seen: ${i.lastErrorReportTime ?? '?'}\n` +
                      `   Issue ID: ${i.name}`,
                  )
                  .join('\n\n'),
            },
          ],
        };
      } catch (error) {
        return formatError(error);
      }
    },
  );
}
