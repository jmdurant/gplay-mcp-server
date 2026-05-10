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

interface StoreListing {
  language?: string;
  title?: string;
  fullDescription?: string;
  shortDescription?: string;
  video?: string;
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
    'submit_data_safety',
    'Submit the Data Safety declaration via the Publishing API. Workflow: ' +
      'fill out the Data Safety form ONCE in Play Console UI for the source ' +
      'app, export the CSV from the Data Safety section, then use this tool ' +
      'to replay the same declarations to other apps (variants, white-labels) ' +
      'without redoing the questionnaire. Endpoint is application-level, not ' +
      'inside an Edit transaction.',
    {
      packageName: z.string().describe('Android package name'),
      csvPath: z.string().describe(
        'Absolute path to the Data Safety CSV file exported from Play Console ' +
        '(Policy > App content > Data safety > Export current responses)'
      ),
    },
    async ({ packageName, csvPath }) => {
      try {
        const { existsSync, readFileSync } = await import('node:fs');
        if (!existsSync(csvPath)) {
          return formatError(new Error(`CSV file not found: ${csvPath}`));
        }
        const csv = readFileSync(csvPath, 'utf-8');

        await client.request(
          `/applications/${packageName}/dataSafety`,
          {
            method: 'POST',
            body: { safetyLabels: csv },
          }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Data Safety declaration submitted for ${packageName}.\n` +
              `Source CSV: ${csvPath} (${csv.length} chars)`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'apply_default_settings',
    'Bundled app-shell setup: in one Edits transaction, apply contact ' +
      'details, a store listing (title/short/full description), and any of ' +
      'icon, feature graphic, and phone screenshots from local files. ' +
      'Optionally submits a Data Safety CSV afterward (separate endpoint, ' +
      'outside the edit). ' +
      'Designed to spin up a new variant\'s Play Console shell from ' +
      'config-driven defaults without clicking through the UI for each one. ' +
      'NOTE: content rating, target audience, app access, ads/news/financial ' +
      'declarations still require the Play Console UI — Google does not ' +
      'expose them via the Publishing API.',
    {
      packageName: z.string().describe('Android package name'),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().optional(),
      contactWebsite: z.string().url().optional(),
      defaultLanguage: z.string().optional().describe('Default listing language (default: en-US)'),
      storeListing: z.object({
        language: z.string().optional().describe('Listing language (default: en-US)'),
        title: z.string().optional().describe('App title (max 50 chars)'),
        shortDescription: z.string().optional().describe('Short description (max 80 chars)'),
        fullDescription: z.string().optional().describe('Full description (max 4000 chars)'),
        video: z.string().optional().describe('YouTube video URL'),
      }).optional().describe('Store listing text fields'),
      images: z.object({
        icon: z.string().optional().describe('Path to icon PNG (512x512)'),
        featureGraphic: z.string().optional().describe('Path to feature graphic PNG/JPG (1024x500)'),
        phoneScreenshots: z.array(z.string()).optional().describe('Paths to phone screenshot images (PNG/JPG)'),
      }).optional().describe('Local image file paths to upload'),
      dataSafetyCsvPath: z.string().optional().describe('Path to Data Safety CSV exported from Play Console UI'),
    },
    async ({ packageName, contactEmail, contactPhone, contactWebsite, defaultLanguage, storeListing, images, dataSafetyCsvPath }) => {
      try {
        const { existsSync, readFileSync } = await import('node:fs');
        const { extname } = await import('node:path');

        // Validate all input files exist BEFORE creating the edit so we don't
        // half-commit and discover a missing screenshot at upload time.
        const filesToCheck: string[] = [];
        if (images?.icon) filesToCheck.push(images.icon);
        if (images?.featureGraphic) filesToCheck.push(images.featureGraphic);
        if (images?.phoneScreenshots) filesToCheck.push(...images.phoneScreenshots);
        if (dataSafetyCsvPath) filesToCheck.push(dataSafetyCsvPath);
        const missing = filesToCheck.filter(p => !existsSync(p));
        if (missing.length > 0) {
          return formatError(new Error(`File(s) not found: ${missing.join(', ')}`));
        }

        const log: string[] = [];
        const hasEditWork = !!(
          contactEmail || contactPhone || contactWebsite || defaultLanguage ||
          storeListing || images
        );

        if (hasEditWork) {
          const edit = await client.request<AppEdit>(
            `/applications/${packageName}/edits`,
            { method: 'POST', body: {} }
          );
          log.push(`Created edit ${edit.id}`);

          // 1. Contact details (merged with current to avoid wiping fields).
          if (contactEmail || contactPhone || contactWebsite || defaultLanguage) {
            let current: AppDetails = {};
            try {
              current = await client.request<AppDetails>(
                `/applications/${packageName}/edits/${edit.id}/details`
              );
            } catch { /* none */ }
            const merged: Record<string, unknown> = { ...current };
            if (contactEmail) merged.contactEmail = contactEmail;
            if (contactPhone) merged.contactPhone = contactPhone;
            if (contactWebsite) merged.contactWebsite = contactWebsite;
            if (defaultLanguage) merged.defaultLanguage = defaultLanguage;
            await client.request(
              `/applications/${packageName}/edits/${edit.id}/details`,
              { method: 'PUT', body: merged }
            );
            const fields = [
              contactEmail && 'contactEmail',
              contactPhone && 'contactPhone',
              contactWebsite && 'contactWebsite',
              defaultLanguage && 'defaultLanguage',
            ].filter(Boolean).join(', ');
            log.push(`Updated app details: ${fields}`);
          }

          // 2. Store listing (merged with current so partial updates don't blank fields).
          if (storeListing) {
            const lang = storeListing.language ?? 'en-US';
            let existing: StoreListing = {};
            try {
              existing = await client.request<StoreListing>(
                `/applications/${packageName}/edits/${edit.id}/listings/${lang}`
              );
            } catch { /* none */ }
            const updated: Record<string, unknown> = {
              language: lang,
              title: storeListing.title ?? existing.title ?? '',
              fullDescription: storeListing.fullDescription ?? existing.fullDescription ?? '',
              shortDescription: storeListing.shortDescription ?? existing.shortDescription ?? '',
            };
            if (storeListing.video !== undefined) {
              updated.video = storeListing.video;
            } else if (existing.video) {
              updated.video = existing.video;
            }
            await client.request(
              `/applications/${packageName}/edits/${edit.id}/listings/${lang}`,
              { method: 'PUT', body: updated }
            );
            log.push(`Updated store listing (${lang})`);
          }

          // 3. Images (each upload goes to /edits/{id}/listings/{lang}/{type}).
          if (images) {
            const token = await client.getAccessToken();
            const lang = storeListing?.language ?? 'en-US';
            const uploadOne = async (filePath: string, imageType: string) => {
              const ext = extname(filePath).toLowerCase();
              const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
              const fileBuffer = readFileSync(filePath);
              const uploadUrl = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}/edits/${edit.id}/listings/${lang}/${imageType}?uploadType=media`;
              await client.uploadRequest(uploadUrl, fileBuffer, contentType, token);
            };
            if (images.icon) {
              await uploadOne(images.icon, 'icon');
              log.push('Uploaded icon');
            }
            if (images.featureGraphic) {
              await uploadOne(images.featureGraphic, 'featureGraphic');
              log.push('Uploaded featureGraphic');
            }
            if (images.phoneScreenshots && images.phoneScreenshots.length > 0) {
              for (const p of images.phoneScreenshots) {
                await uploadOne(p, 'phoneScreenshots');
              }
              log.push(`Uploaded ${images.phoneScreenshots.length} phone screenshot(s)`);
            }
          }

          // 4. Commit (single atomic edit across details/listing/images).
          await client.request(
            `/applications/${packageName}/edits/${edit.id}:commit`,
            { method: 'POST' }
          );
          log.push('Committed edit');
        }

        // 5. Data Safety (application-level, NOT inside the edit).
        if (dataSafetyCsvPath) {
          const csv = readFileSync(dataSafetyCsvPath, 'utf-8');
          await client.request(
            `/applications/${packageName}/dataSafety`,
            {
              method: 'POST',
              body: { safetyLabels: csv },
            }
          );
          log.push(`Submitted Data Safety declaration (${csv.length} chars)`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Default settings applied for ${packageName}:\n\n` +
              log.map(l => `  - ${l}`).join('\n') +
              `\n\nStill manual in Play Console (Google has not exposed via API):\n` +
              `  - Content rating questionnaire\n` +
              `  - Target audience declaration\n` +
              `  - App access (reviewer credentials)\n` +
              `  - Ads / news / financial features declarations\n` +
              `  - Privacy policy URL`,
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
