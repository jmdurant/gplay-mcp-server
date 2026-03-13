import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppEdit {
  id: string;
}

interface Tester {
  googleGroups?: string[];
  googleGroupEmails?: string[];
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
    'Add email addresses as testers for a track',
    {
      packageName: z.string().describe('Android package name'),
      emails: z.array(z.string()).describe('Array of tester email addresses'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track (default: internal)'),
    },
    async ({ packageName, emails, track }) => {
      try {
        const targetTrack = track ?? 'internal';
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
          existingEmails = existing.googleGroupEmails ?? [];
        } catch { /* no existing testers */ }

        // Merge and dedupe
        const allEmails = [...new Set([...existingEmails, ...emails])];

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`,
          {
            method: 'PUT',
            body: { googleGroupEmails: allEmails },
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
        const remaining = (existing.googleGroupEmails ?? []).filter(
          e => !removeSet.has(e.toLowerCase())
        );

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/testers/${targetTrack}`,
          {
            method: 'PUT',
            body: { googleGroupEmails: remaining },
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
