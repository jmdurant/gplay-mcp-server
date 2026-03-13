import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError, GooglePlayError } from '../errors.js';

interface AppEdit {
  id: string;
  expiryTimeSeconds: string;
}

interface AppDetails {
  defaultLanguage?: string;
  contactEmail?: string;
  contactWebsite?: string;
  contactPhone?: string;
}

interface Track {
  track: string;
  releases: Array<{
    versionCodes: string[];
    status: string;
    name?: string;
  }>;
}

interface StoreListing {
  language?: string;
  title?: string;
  fullDescription?: string;
  shortDescription?: string;
}

export function registerPreflightTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'preflight_check',
    'Run preflight checks to validate an app is ready for upload. Verifies service account access, app existence, edit creation, app details, store listing, and current track status.',
    {
      packageName: z.string().describe('Android package name (e.g. "com.example.app")'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track to check (default: internal)'),
    },
    async ({ packageName, track }) => {
      const targetTrack = track ?? 'internal';
      const checks: Array<{ check: string; status: 'pass' | 'fail' | 'warn'; detail: string }> = [];

      // Check 1: Service account access — can we create an edit?
      let editId: string | null = null;
      try {
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );
        editId = edit.id;
        checks.push({
          check: 'Service account access',
          status: 'pass',
          detail: `Edit created (ID: ${edit.id}, expires: ${edit.expiryTimeSeconds})`,
        });
      } catch (error) {
        if (error instanceof GooglePlayError && error.status === 404) {
          checks.push({
            check: 'App exists',
            status: 'fail',
            detail: `App '${packageName}' not found. It must be created in Google Play Console first.`,
          });
        } else if (error instanceof GooglePlayError && error.status === 403) {
          checks.push({
            check: 'Service account access',
            status: 'fail',
            detail: `Permission denied. Grant the service account access in Play Console > Settings > API access. Error: ${error.detail}`,
          });
        } else {
          checks.push({
            check: 'Service account access',
            status: 'fail',
            detail: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          });
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Preflight Check Results for ${packageName}\n` +
              `${'='.repeat(50)}\n\n` +
              checks.map(c => `${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'WARN'}: ${c.check}\n  ${c.detail}`).join('\n\n') +
              '\n\nPreflight FAILED — cannot proceed without app access.',
          }],
        };
      }

      // Check 2: App details
      try {
        const details = await client.request<AppDetails>(
          `/applications/${packageName}/edits/${editId}/details`
        );

        const missing: string[] = [];
        if (!details.defaultLanguage) missing.push('defaultLanguage');
        if (!details.contactEmail) missing.push('contactEmail');

        if (missing.length > 0) {
          checks.push({
            check: 'App details',
            status: 'warn',
            detail: `Missing recommended fields: ${missing.join(', ')}. Current: ${JSON.stringify(details)}`,
          });
        } else {
          checks.push({
            check: 'App details',
            status: 'pass',
            detail: `Language: ${details.defaultLanguage}, Contact: ${details.contactEmail}`,
          });
        }
      } catch (error) {
        checks.push({
          check: 'App details',
          status: 'warn',
          detail: `Could not retrieve app details: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // Check 3: Store listing
      try {
        const listing = await client.request<StoreListing>(
          `/applications/${packageName}/edits/${editId}/listings/en-US`
        );

        const missing: string[] = [];
        if (!listing.title) missing.push('title');
        if (!listing.shortDescription) missing.push('shortDescription');
        if (!listing.fullDescription) missing.push('fullDescription');

        if (missing.length > 0) {
          checks.push({
            check: 'Store listing (en-US)',
            status: 'warn',
            detail: `Missing fields: ${missing.join(', ')}. These are required for production release.`,
          });
        } else {
          checks.push({
            check: 'Store listing (en-US)',
            status: 'pass',
            detail: `Title: "${listing.title}", Short desc: ${listing.shortDescription?.length ?? 0} chars, Full desc: ${listing.fullDescription?.length ?? 0} chars`,
          });
        }
      } catch {
        checks.push({
          check: 'Store listing (en-US)',
          status: 'warn',
          detail: 'No en-US store listing found. Required before first release.',
        });
      }

      // Check 4: Track status
      try {
        const trackInfo = await client.request<Track>(
          `/applications/${packageName}/edits/${editId}/tracks/${targetTrack}`
        );

        if (trackInfo.releases?.length) {
          const latest = trackInfo.releases[0];
          checks.push({
            check: `Track: ${targetTrack}`,
            status: 'pass',
            detail: `Active release — version codes: [${latest.versionCodes?.join(', ') ?? 'none'}], status: ${latest.status}`,
          });
        } else {
          checks.push({
            check: `Track: ${targetTrack}`,
            status: 'pass',
            detail: 'No existing releases on this track. Ready for first upload.',
          });
        }
      } catch {
        checks.push({
          check: `Track: ${targetTrack}`,
          status: 'pass',
          detail: 'No existing releases on this track. Ready for first upload.',
        });
      }

      // Clean up the edit
      try {
        await client.request(
          `/applications/${packageName}/edits/${editId}`,
          { method: 'DELETE' }
        );
      } catch { /* best effort cleanup */ }

      const hasFail = checks.some(c => c.status === 'fail');
      const hasWarn = checks.some(c => c.status === 'warn');
      const summary = hasFail ? 'FAILED' : hasWarn ? 'PASSED with warnings' : 'ALL CHECKS PASSED';

      return {
        content: [{
          type: 'text' as const,
          text: `Preflight Check Results for ${packageName}\n` +
            `${'='.repeat(50)}\n\n` +
            checks.map(c => `${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'WARN'}: ${c.check}\n  ${c.detail}`).join('\n\n') +
            `\n\n${'-'.repeat(50)}\nResult: ${summary}`,
        }],
      };
    }
  );
}
