import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppEdit {
  id: string;
}

interface StoreListing {
  language?: string;
  title?: string;
  fullDescription?: string;
  shortDescription?: string;
  video?: string;
}

interface StoreListingsResponse {
  listings: StoreListing[];
}

export function registerListingTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'get_store_listing',
    'Get the current store listing for an app (title, description, etc.)',
    {
      packageName: z.string().describe('Android package name (e.g. "com.example.app")'),
      language: z.string().optional().describe('Language code (default: en-US)'),
    },
    async ({ packageName, language }) => {
      try {
        const lang = language ?? 'en-US';

        // Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Get the listing for the specified language
        const listing = await client.request<StoreListing>(
          `/applications/${packageName}/edits/${edit.id}/listings/${lang}`
        );

        // Clean up the edit (read-only, no commit needed)
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

  server.tool(
    'update_store_listing',
    'Update store listing text for an app (title, descriptions, video URL)',
    {
      packageName: z.string().describe('Android package name'),
      language: z.string().optional().describe('Language code (default: en-US)'),
      title: z.string().optional().describe('App title (max 50 chars)'),
      fullDescription: z.string().optional().describe('Full description (max 4000 chars)'),
      shortDescription: z.string().optional().describe('Short description (max 80 chars)'),
      video: z.string().optional().describe('YouTube video URL'),
    },
    async ({ packageName, language, title, fullDescription, shortDescription, video }) => {
      try {
        const lang = language ?? 'en-US';

        // Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Get existing listing to merge with updates
        let existing: StoreListing = {};
        try {
          existing = await client.request<StoreListing>(
            `/applications/${packageName}/edits/${edit.id}/listings/${lang}`
          );
        } catch { /* no existing listing */ }

        // Build updated listing (merge existing with provided fields)
        const updated: StoreListing = {
          language: lang,
          title: title ?? existing.title ?? '',
          fullDescription: fullDescription ?? existing.fullDescription ?? '',
          shortDescription: shortDescription ?? existing.shortDescription ?? '',
        };
        if (video !== undefined) {
          updated.video = video;
        } else if (existing.video) {
          updated.video = existing.video;
        }

        // Update the listing
        const result = await client.request<StoreListing>(
          `/applications/${packageName}/edits/${edit.id}/listings/${lang}`,
          { method: 'PUT', body: updated }
        );

        // Commit the edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Store listing updated for ${packageName} (${lang}).\n${JSON.stringify(result, null, 2)}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'list_store_listings',
    'List all language listings for an app',
    {
      packageName: z.string().describe('Android package name'),
    },
    async ({ packageName }) => {
      try {
        // Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Get all listings
        const response = await client.request<StoreListingsResponse>(
          `/applications/${packageName}/edits/${edit.id}/listings`
        );

        // Clean up the edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}`,
          { method: 'DELETE' }
        );

        return { content: [{ type: 'text' as const, text: JSON.stringify(response.listings ?? [], null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
