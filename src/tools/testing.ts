import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppEdit {
  id: string;
}

interface Tester {
  // Per the Play Developer API v3 Testers resource, only googleGroups is
  // accepted — individual emails must be added via the Play Console UI.
  googleGroups?: string[];
}

interface InternalAppSharingArtifact {
  certificateFingerprint: string;
  downloadUrl: string;
  sha256: string;
}

export function registerTestingTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'list_testers',
    'List testers for a specific track',
    {
      packageName: z.string().describe('Android package name'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track (default: internal)'),
    },
    async ({ packageName, track }) => {
      try {
        const targetTrack = track ?? 'internal';
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const testers = await client.request<Tester>(
          `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`
        );

        await client.request(
          `/applications/${packageName}/edits/${edit.id}`,
          { method: 'DELETE' }
        );

        return { content: [{ type: 'text' as const, text: JSON.stringify(testers, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'add_testers',
    'Add Google Group email addresses as testers for a track. ' +
      'NOTE: The Play Developer API only accepts Google Group addresses (e.g. ' +
      'my-testers@googlegroups.com), not individual user emails. To add ' +
      'individual testers, use the Play Console UI.',
    {
      packageName: z.string().describe('Android package name'),
      emails: z.array(z.string()).describe(
        'Array of Google Group email addresses (NOT individual user emails)'
      ),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track (default: internal)'),
    },
    async ({ packageName, emails, track }) => {
      try {
        const targetTrack = track ?? 'internal';

        // Reject obvious non-group addresses early so the user gets a clear
        // error rather than a cryptic API rejection.
        const personalDomains = /@(gmail|yahoo|outlook|hotmail|icloud|protonmail)\.com$/i;
        const personalEmails = emails.filter(e => personalDomains.test(e));
        if (personalEmails.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Cannot add individual user emails via the API: ${personalEmails.join(', ')}\n\n` +
                `The Play Developer API only accepts Google Group addresses for testers ` +
                `(e.g. my-testers@googlegroups.com).\n\n` +
                `To add individual testers, either:\n` +
                `  1. Add them via the Play Console UI (Testing > Internal testing > Testers tab), or\n` +
                `  2. Create a Google Group, add the testers to it, and pass the group's email here.`,
            }],
          };
        }

        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Get existing testers
        let existingEmails: string[] = [];
        try {
          const existing = await client.request<Tester>(
            `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`
          );
          existingEmails = existing.googleGroups ?? [];
        } catch { /* no existing testers */ }

        // Merge and dedupe
        const allEmails = [...new Set([...existingEmails, ...emails])];

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`,
          {
            method: 'PUT',
            body: { googleGroups: allEmails },
          }
        );

        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Added ${emails.length} tester(s) to ${targetTrack} track.\n` +
              `Total testers: ${allEmails.length}\n\n` +
              JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'remove_testers',
    'Remove email addresses from testers for a track',
    {
      packageName: z.string().describe('Android package name'),
      emails: z.array(z.string()).describe('Array of tester email addresses to remove'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track (default: internal)'),
    },
    async ({ packageName, emails, track }) => {
      try {
        const targetTrack = track ?? 'internal';
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const existing = await client.request<Tester>(
          `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`
        );

        const removeSet = new Set(emails.map(e => e.toLowerCase()));
        const remaining = (existing.googleGroups ?? []).filter(
          e => !removeSet.has(e.toLowerCase())
        );

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`,
          {
            method: 'PUT',
            body: { googleGroups: remaining },
          }
        );

        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Removed ${emails.length} tester(s) from ${targetTrack} track.\n` +
              `Remaining testers: ${remaining.length}\n\n` +
              JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
