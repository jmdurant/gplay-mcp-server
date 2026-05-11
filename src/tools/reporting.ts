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
        // End yesterday — today's metrics aren't aggregated yet.
        const endTime = daysAgo(1);

        const baseBody = {
          dimensions: [] as string[],
          timelineSpec: {
            aggregationPeriod: 'DAILY',
            startTime,
            endTime,
          },
        };

        const crash = await client.request<MetricQueryResponse>(
          `/apps/${packageName}/crashRateMetricSet:query`,
          {
            method: 'POST',
            body: { ...baseBody, metrics: ['crashRate'] },
            baseUrl: REPORTING_BASE_URL,
          },
        );

        const anr = await client.request<MetricQueryResponse>(
          `/apps/${packageName}/anrRateMetricSet:query`,
          {
            method: 'POST',
            body: { ...baseBody, metrics: ['anrRate'] },
            baseUrl: REPORTING_BASE_URL,
          },
        );

        const crashRows = crash.rows ?? [];
        const anrRows = anr.rows ?? [];

        const hasData = crashRows.length > 0 || anrRows.length > 0;

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `App health for ${packageName} ` +
                `(${window}-day window ending ${endTime.year}-${String(endTime.month).padStart(2, '0')}-${String(endTime.day).padStart(2, '0')}):\n\n` +
                `Crash rate: ${formatRate(crashRows, 'crashRate')} ` +
                `(${crashRows.length} day(s) of data)\n` +
                `ANR rate:   ${formatRate(anrRows, 'anrRate')} ` +
                `(${anrRows.length} day(s) of data)\n\n` +
                (hasData
                  ? "Data lags by 1 day — today's metrics arrive tomorrow."
                  : 'No data returned. Common reasons: app has very low ' +
                    'install volume, app was just shipped, or the Reporting ' +
                    'API is not yet enabled for the project. Enable at ' +
                    'https://console.cloud.google.com/apis/library/playdeveloperreporting.googleapis.com'),
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
