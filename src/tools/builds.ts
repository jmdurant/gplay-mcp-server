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
    userFraction?: number;
  }>;
}

interface AppDetails {
  defaultLanguage?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactWebsite?: string;
}

interface Tester {
  googleGroups?: string[];
}

const PERSONAL_DOMAINS = /@(gmail|yahoo|outlook|hotmail|icloud|protonmail)\.com$/i;

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
    'set_release_status',
    'Change the status of the latest release on a track without re-uploading. ' +
      'The most common use is flipping a draft release to "completed" after ' +
      'Play Console declarations (content rating, target audience, data safety, ' +
      'privacy policy) have been filled in. Without this, your only options ' +
      'are re-uploading the bundle or clicking through the Play Console UI.',
    {
      packageName: z.string().describe('Android package name'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track (default: internal)'),
      status: z.enum(['draft', 'completed', 'halted', 'inProgress']).describe('New release status'),
      rolloutPercentage: z.number().min(0).max(100).optional().describe('Rollout percentage when setting status to inProgress (0-100)'),
    },
    async ({ packageName, track, status, rolloutPercentage }) => {
      try {
        const targetTrack = track ?? 'internal';

        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const trackInfo = await client.request<Track>(
          `/applications/${packageName}/edits/${edit.id}/tracks/${targetTrack}`
        );

        if (!trackInfo.releases?.length) {
          await client.request(
            `/applications/${packageName}/edits/${edit.id}`,
            { method: 'DELETE' }
          );
          return formatError(new Error(
            `No releases found on ${targetTrack} track for ${packageName}.`
          ));
        }

        // Modify only the latest release; preserve any others on the track.
        const releases = trackInfo.releases.map((r, i) => {
          if (i !== 0) return r;
          const updated: Record<string, unknown> = { ...r, status };
          if (status === 'inProgress' && rolloutPercentage != null) {
            updated.userFraction = rolloutPercentage / 100;
          } else {
            // userFraction only valid for inProgress; remove otherwise.
            delete updated.userFraction;
          }
          return updated;
        });

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/tracks/${targetTrack}`,
          {
            method: 'PUT',
            body: { track: targetTrack, releases },
          }
        );

        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        const previousStatus = trackInfo.releases[0].status;
        return {
          content: [{
            type: 'text' as const,
            text: `Release status changed: ${previousStatus} -> ${status} ` +
              `on ${targetTrack} track for ${packageName}.\n` +
              `Version codes: ${trackInfo.releases[0].versionCodes.join(', ')}\n\n` +
              JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'submit_to_internal',
    'Bundled workflow: optionally update app contact details, upload an AAB ' +
      'to the internal track, optionally set Google Group testers, and set ' +
      'the final release status — all in one Edits transaction. Faster than ' +
      'calling update_app_details + upload_bundle + add_testers + commit ' +
      'separately, since they all share one edit. ' +
      'NOTE: privacy policy URL still has to be set manually in Play Console; ' +
      'the Publishing API does not expose that field.',
    {
      packageName: z.string().describe('Android package name'),
      aabPath: z.string().describe('Absolute path to the .aab file'),
      releaseName: z.string().optional().describe('Release name (e.g. "1.0.0 (1)")'),
      releaseStatus: z.enum(['draft', 'completed']).optional().describe(
        'Final release status (default: completed). Use "draft" to keep the ' +
        'release hidden until Play Console declarations are complete; flip ' +
        'later with set_release_status.'
      ),
      contactEmail: z.string().email().optional().describe('Update app contact email before upload'),
      contactPhone: z.string().optional().describe('Update app contact phone before upload'),
      contactWebsite: z.string().url().optional().describe('Update app contact website before upload'),
      googleGroupTesters: z.array(z.string()).optional().describe(
        'Google Group email addresses (e.g. my-testers@googlegroups.com) to ' +
        'add as internal testers. Personal emails are skipped with a warning.'
      ),
    },
    async ({ packageName, aabPath, releaseName, releaseStatus, contactEmail, contactPhone, contactWebsite, googleGroupTesters }) => {
      try {
        const { existsSync, readFileSync } = await import('node:fs');
        if (!existsSync(aabPath)) {
          return formatError(new Error(`AAB file not found: ${aabPath}`));
        }

        const targetTrack = 'internal';
        const finalStatus = releaseStatus ?? 'completed';
        const log: string[] = [];

        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );
        log.push(`Created edit ${edit.id}`);

        // 1. Update app details if any contact fields supplied.
        if (contactEmail || contactPhone || contactWebsite) {
          let current: AppDetails = {};
          try {
            current = await client.request<AppDetails>(
              `/applications/${packageName}/edits/${edit.id}/details`
            );
          } catch { /* no existing details */ }

          const merged: Record<string, unknown> = { ...current };
          if (contactEmail) merged.contactEmail = contactEmail;
          if (contactPhone) merged.contactPhone = contactPhone;
          if (contactWebsite) merged.contactWebsite = contactWebsite;

          await client.request(
            `/applications/${packageName}/edits/${edit.id}/details`,
            { method: 'PUT', body: merged }
          );

          const updatedFields = [
            contactEmail && 'contactEmail',
            contactPhone && 'contactPhone',
            contactWebsite && 'contactWebsite',
          ].filter(Boolean).join(', ');
          log.push(`Updated app details: ${updatedFields}`);
        }

        // 2. Upload AAB.
        const token = await client.getAccessToken();
        const fileBuffer = readFileSync(aabPath);
        const uploadUrl = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}/edits/${edit.id}/bundles?uploadType=media`;
        const bundle = await client.uploadRequest<Bundle>(
          uploadUrl,
          fileBuffer,
          'application/octet-stream',
          token
        );
        log.push(`Uploaded AAB (versionCode: ${bundle.versionCode})`);

        // 3. Assign to internal track.
        const release: Record<string, unknown> = {
          versionCodes: [String(bundle.versionCode)],
          status: finalStatus,
        };
        if (releaseName) release.name = releaseName;

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/tracks/${targetTrack}`,
          {
            method: 'PUT',
            body: { track: targetTrack, releases: [release] },
          }
        );
        log.push(`Assigned to ${targetTrack} track with status '${finalStatus}'`);

        // 4. Add Google Group testers if supplied (filter personal emails).
        if (googleGroupTesters && googleGroupTesters.length > 0) {
          const personal = googleGroupTesters.filter(e => PERSONAL_DOMAINS.test(e));
          const groups = googleGroupTesters.filter(e => !PERSONAL_DOMAINS.test(e));

          if (personal.length > 0) {
            log.push(
              `Skipped non-group emails: ${personal.join(', ')}. ` +
              `Add these via Play Console UI (Testing > Internal testing > Testers).`
            );
          }

          if (groups.length > 0) {
            let existingGroups: string[] = [];
            try {
              const existing = await client.request<Tester>(
                `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`
              );
              existingGroups = existing.googleGroups ?? [];
            } catch { /* none */ }

            const allGroups = [...new Set([...existingGroups, ...groups])];
            await client.request(
              `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`,
              {
                method: 'PUT',
                body: { googleGroups: allGroups },
              }
            );
            log.push(`Set Google Group testers: ${allGroups.join(', ')}`);
          }
        }

        // 5. Commit the edit (single atomic transaction across all the above).
        await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );
        log.push('Committed edit');

        const finalNote = finalStatus === 'draft'
          ? 'Release is in DRAFT — testers will not see it. Once Play Console ' +
            'declarations (content rating, target audience, data safety, ' +
            'privacy policy) are complete, call set_release_status with ' +
            'status="completed" to publish.'
          : 'Release is COMPLETED — internal testers should see it shortly. ' +
            'If they don\'t, check that Play Console declarations are filled ' +
            'in; Play silently drops releases to draft when they\'re not.';

        return {
          content: [{
            type: 'text' as const,
            text: `Submission to internal track complete for ${packageName}.\n\n` +
              log.map(l => `  - ${l}`).join('\n') +
              `\n\nVersion code: ${bundle.versionCode}\n` +
              `Track: ${targetTrack}\n` +
              `Status: ${finalStatus}\n\n` +
              finalNote,
          }],
        };
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
