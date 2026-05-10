import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppDetails {
  defaultLanguage?: string;
  title?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactWebsite?: string;
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
    'update_app_details',
    'Update app-level contact details (email, phone, website) and default ' +
      'language via the Edits API. ' +
      'NOTE: the Play Publishing API does NOT expose the privacy policy URL ' +
      'field — that has to be set manually once per app in Play Console > ' +
      'Policy > App content > Privacy policy. The MCP can\'t bypass that.',
    {
      packageName: z.string().describe('Android package name'),
      contactEmail: z.string().email().optional().describe('Public support email on the store listing'),
      contactPhone: z.string().optional().describe('Public support phone'),
      contactWebsite: z.string().url().optional().describe('Public support website'),
      defaultLanguage: z.string().optional().describe('Default listing language (e.g. en-US)'),
    },
    async ({ packageName, contactEmail, contactPhone, contactWebsite, defaultLanguage }) => {
      try {
        const update: Record<string, string> = {};
        if (contactEmail) update.contactEmail = contactEmail;
        if (contactPhone) update.contactPhone = contactPhone;
        if (contactWebsite) update.contactWebsite = contactWebsite;
        if (defaultLanguage) update.defaultLanguage = defaultLanguage;

        if (Object.keys(update).length === 0) {
          return formatError(new Error(
            'No fields to update. Pass at least one of: contactEmail, ' +
            'contactPhone, contactWebsite, defaultLanguage.'
          ));
        }

        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // PUT replaces the resource, so merge with current values to avoid
        // wiping fields the caller didn't pass.
        let current: AppDetails = {};
        try {
          current = await client.request<AppDetails>(
            `/applications/${packageName}/edits/${edit.id}/details`
          );
        } catch { /* no existing details */ }

        const merged = { ...current, ...update };

        await client.request(
          `/applications/${packageName}/edits/${edit.id}/details`,
          { method: 'PUT', body: merged }
        );

        const result = await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `App details updated for ${packageName}.\n` +
              `Updated fields: ${Object.keys(update).join(', ')}\n\n` +
              JSON.stringify(result, null, 2),
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
