import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppDetails {
  defaultLanguage?: string;
  title?: string;
  contactEmail?: string;
}

interface AppEdit {
  id: string;
  expiryTimeSeconds: string;
}

export function registerAppTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'list_apps',
    'List all apps in Google Play Console. Note: The API does not have a direct list endpoint — provide your known package names.',
    {
      packageNames: z.array(z.string()).describe('Array of package names to check (e.g. ["com.example.app"])'),
    },
    async ({ packageNames }) => {
      const results: Array<{ packageName: string; status: string; details?: unknown }> = [];

      for (const pkg of packageNames) {
        try {
          // Try to start an edit to verify the app exists
          const edit = await client.request<AppEdit>(
            `/applications/${pkg}/edits`,
            { method: 'POST', body: {} }
          );
          // Clean up the edit
          await client.request(
            `/applications/${pkg}/edits/${edit.id}`,
            { method: 'DELETE' }
          );
          results.push({ packageName: pkg, status: 'exists' });
        } catch {
          results.push({ packageName: pkg, status: 'not_found_or_no_access' });
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'create_app',
    'Create a new app listing in Google Play Console. Unlike Apple, Google\'s API supports this directly.',
    {
      packageName: z.string().describe('Android package name (e.g. "com.doctordurant.tripassistant")'),
      title: z.string().describe('App title as it will appear on Google Play'),
      defaultLanguage: z.string().optional().describe('Default language (default: en-US)'),
    },
    async ({ packageName, title, defaultLanguage }) => {
      try {
        // Step 1: Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Step 2: Set the app listing details
        await client.request(
          `/applications/${packageName}/edits/${edit.id}/listings/${defaultLanguage ?? 'en-US'}`,
          {
            method: 'PUT',
            body: { title, fullDescription: '', shortDescription: '' },
          }
        );

        // Step 3: Commit the edit
        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `App '${title}' created/updated for package '${packageName}'.\n${JSON.stringify(result, null, 2)}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'get_app_details',
    'Get listing details for an app on Google Play',
    {
      packageName: z.string().describe('Android package name'),
      language: z.string().optional().describe('Language code (default: en-US)'),
    },
    async ({ packageName, language }) => {
      try {
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const listing = await client.request<AppDetails>(
          `/applications/${packageName}/edits/${edit.id}/listings/${language ?? 'en-US'}`
        );

        // Clean up edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}`,
          { method: 'DELETE' }
        );

        return { content: [{ type: 'text' as const, text: JSON.stringify(listing, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
