import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

const execFileAsync = promisify(execFile);

interface AppEdit {
  id: string;
  expiryTimeSeconds: string;
}

interface Bundle {
  versionCode: number;
  sha256: string;
}

interface Track {
  track: string;
  releases: Array<{
    versionCodes: string[];
    status: string;
    name?: string;
  }>;
}

export function registerBuildTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'upload_bundle',
    'Upload an AAB (Android App Bundle) to Google Play. Creates an edit, uploads the bundle, assigns it to a track, and commits.',
    {
      packageName: z.string().describe('Android package name (e.g. "com.example.app")'),
      aabPath: z.string().describe('Absolute path to the .aab file'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Release track (default: internal)'),
      releaseName: z.string().optional().describe('Release name (e.g. "1.0.0 (1)")'),
      releaseStatus: z.enum(['draft', 'completed', 'halted', 'inProgress']).optional().describe('Release status (default: completed)'),
      rolloutPercentage: z.number().min(0).max(100).optional().describe('Percentage of users to roll out to (0-100, default: 100). Values < 100 automatically set status to inProgress.'),
    },
    async ({ packageName, aabPath, track, releaseName, releaseStatus, rolloutPercentage }) => {
      try {
        const { existsSync, readFileSync } = await import('node:fs');
        if (!existsSync(aabPath)) {
          return formatError(new Error(`AAB file not found: ${aabPath}`));
        }

        const targetTrack = track ?? 'internal';
        const fraction = rolloutPercentage != null ? rolloutPercentage / 100 : 1;
        const status = fraction < 1 ? 'inProgress' : (releaseStatus ?? 'completed');

        // Step 1: Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Step 2: Upload the AAB
        const token = await client.getAccessToken();
        const fileBuffer = readFileSync(aabPath);

        const uploadUrl = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}/edits/${edit.id}/bundles?uploadType=media`;

        const bundle = await client.uploadRequest<Bundle>(
          uploadUrl,
          fileBuffer,
          'application/octet-stream',
          token
        );

        // Step 3: Assign to track
        const release: Record<string, unknown> = {
          versionCodes: [String(bundle.versionCode)],
          status,
          name: releaseName,
        };
        if (fraction < 1) {
          release.userFraction = fraction;
        }

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/tracks/${targetTrack}`,
          {
            method: 'PUT',
            body: {
              track: targetTrack,
              releases: [release],
            },
          }
        );

        // Step 4: Commit the edit
        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Bundle uploaded successfully!\n` +
              `Package: ${packageName}\n` +
              `Version code: ${bundle.versionCode}\n` +
              `Track: ${targetTrack}\n` +
              `Status: ${status}\n` +
              `Rollout: ${Math.round(fraction * 100)}%\n\n` +
              JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'build_flutter',
    'Build a Flutter project and produce an AAB for Google Play upload.',
    {
      projectPath: z.string().describe('Absolute path to the Flutter project root'),
      buildNumber: z.string().optional().describe('Build number (versionCode)'),
      buildName: z.string().optional().describe('Version name (e.g. "1.0.0")'),
    },
    async ({ projectPath, buildNumber, buildName }) => {
      try {
        const { existsSync } = await import('node:fs');
        if (!existsSync(projectPath)) {
          return formatError(new Error(`Project not found: ${projectPath}`));
        }

        const args = ['build', 'appbundle', '--release'];
        if (buildNumber) args.push('--build-number', buildNumber);
        if (buildName) args.push('--build-name', buildName);

        const { stdout, stderr } = await execFileAsync('flutter', args, {
          cwd: projectPath,
          maxBuffer: 50 * 1024 * 1024,
          timeout: 600000,
        });

        const output = stdout + stderr;

        // Find the AAB path in the output
        const aabMatch = output.match(/Built (.*\.aab)/);
        const aabPath = aabMatch?.[1] ?? `${projectPath}/build/app/outputs/bundle/release/app-release.aab`;

        if (!existsSync(aabPath)) {
          return formatError(new Error(`Build may have failed. AAB not found at: ${aabPath}\n\nOutput:\n${output}`));
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Flutter build successful!\nAAB: ${aabPath}\n\nUse upload_bundle to upload this to Google Play.`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_tracks',
    'List all release tracks and their current versions for an app',
    {
      packageName: z.string().describe('Android package name'),
    },
    async ({ packageName }) => {
      try {
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const tracks = await client.request<{ tracks: Track[] }>(
          `/applications/${packageName}/edits/${edit.id}/tracks`
        );

        // Clean up edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}`,
          { method: 'DELETE' }
        );

        return { content: [{ type: 'text' as const, text: JSON.stringify(tracks.tracks ?? [], null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'promote_track',
    'Promote a release from one track to another (e.g. internal → beta → production)',
    {
      packageName: z.string().describe('Android package name'),
      fromTrack: z.enum(['internal', 'alpha', 'beta']).describe('Source track'),
      toTrack: z.enum(['alpha', 'beta', 'production']).describe('Destination track'),
      releaseStatus: z.enum(['draft', 'completed', 'halted', 'inProgress']).optional().describe('Release status (default: completed)'),
      rolloutPercentage: z.number().min(0).max(100).optional().describe('Percentage of users to roll out to (0-100, default: 100). Values < 100 automatically set status to inProgress.'),
    },
    async ({ packageName, fromTrack, toTrack, releaseStatus, rolloutPercentage }) => {
      try {
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Get current track info
        const sourceTrack = await client.request<Track>(
          `/applications/${packageName}/edits/${edit.id}/tracks/${fromTrack}`
        );

        if (!sourceTrack.releases?.length) {
          await client.request(`/applications/${packageName}/edits/${edit.id}`, { method: 'DELETE' });
          return formatError(new Error(`No releases found on ${fromTrack} track`));
        }

        const latestRelease = sourceTrack.releases[0];
        const fraction = rolloutPercentage != null ? rolloutPercentage / 100 : 1;
        const status = fraction < 1 ? 'inProgress' : (releaseStatus ?? 'completed');

        // Set on destination track
        const release: Record<string, unknown> = {
          versionCodes: latestRelease.versionCodes,
          status,
        };
        if (fraction < 1) {
          release.userFraction = fraction;
        }

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/tracks/${toTrack}`,
          {
            method: 'PUT',
            body: {
              track: toTrack,
              releases: [release],
            },
          }
        );

        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Promoted from ${fromTrack} → ${toTrack}\n` +
              `Version codes: ${latestRelease.versionCodes.join(', ')}\n` +
              `Rollout: ${Math.round(fraction * 100)}%\n\n` +
              JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
