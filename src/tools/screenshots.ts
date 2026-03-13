import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppEdit {
  id: string;
}

interface Image {
  id: string;
  url: string;
  sha1: string;
  sha256: string;
}

interface ImagesListResponse {
  images: Image[];
}

interface ImageUploadResponse {
  image: Image;
}

const IMAGE_TYPES = [
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
  'icon',
  'featureGraphic',
  'tvBanner',
  'promoGraphic',
] as const;

export function registerScreenshotTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'list_images',
    'List existing images for an app listing (screenshots, icons, feature graphics, etc.)',
    {
      packageName: z.string().describe('Android package name'),
      language: z.string().optional().describe('Language code (default: en-US)'),
      imageType: z.enum(IMAGE_TYPES).describe(
        'Image type: phoneScreenshots, sevenInchScreenshots, tenInchScreenshots, tvScreenshots, wearScreenshots, icon, featureGraphic, tvBanner, promoGraphic'
      ),
    },
    async ({ packageName, language, imageType }) => {
      try {
        const lang = language ?? 'en-US';

        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const response = await client.request<ImagesListResponse>(
          `/applications/${packageName}/edits/${edit.id}/listings/${lang}/${imageType}`
        );

        // Clean up the edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}`,
          { method: 'DELETE' }
        );

        const images = response.images ?? [];
        return {
          content: [{
            type: 'text' as const,
            text: `Found ${images.length} image(s) for ${imageType} (${lang}):\n${JSON.stringify(images, null, 2)}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'upload_image',
    'Upload a screenshot or image to a Google Play store listing',
    {
      packageName: z.string().describe('Android package name'),
      language: z.string().optional().describe('Language code (default: en-US)'),
      imageType: z.enum(IMAGE_TYPES).describe(
        'Image type: phoneScreenshots, sevenInchScreenshots, tenInchScreenshots, tvScreenshots, wearScreenshots, icon, featureGraphic, tvBanner, promoGraphic'
      ),
      filePath: z.string().describe('Absolute path to the image file (PNG or JPEG)'),
    },
    async ({ packageName, language, imageType, filePath }) => {
      try {
        const { existsSync, readFileSync } = await import('node:fs');
        const { extname } = await import('node:path');

        if (!existsSync(filePath)) {
          return formatError(new Error(`Image file not found: ${filePath}`));
        }

        const lang = language ?? 'en-US';

        // Determine content type from extension
        const ext = extname(filePath).toLowerCase();
        let contentType: string;
        if (ext === '.png') {
          contentType = 'image/png';
        } else if (ext === '.jpg' || ext === '.jpeg') {
          contentType = 'image/jpeg';
        } else {
          return formatError(new Error(`Unsupported image format: ${ext}. Use PNG or JPEG.`));
        }

        // Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Upload the image
        const token = await client.getAccessToken();
        const fileBuffer = readFileSync(filePath);

        const uploadUrl = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}/edits/${edit.id}/listings/${lang}/${imageType}?uploadType=media`;

        const result = await client.uploadRequest<ImageUploadResponse>(
          uploadUrl,
          fileBuffer,
          contentType,
          token
        );

        // Commit the edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Image uploaded successfully!\n` +
              `Type: ${imageType}\n` +
              `Language: ${lang}\n` +
              `Image ID: ${result.image?.id ?? 'unknown'}\n\n` +
              JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'delete_image',
    'Delete an image from a Google Play store listing',
    {
      packageName: z.string().describe('Android package name'),
      language: z.string().optional().describe('Language code (default: en-US)'),
      imageType: z.enum(IMAGE_TYPES).describe(
        'Image type: phoneScreenshots, sevenInchScreenshots, tenInchScreenshots, tvScreenshots, wearScreenshots, icon, featureGraphic, tvBanner, promoGraphic'
      ),
      imageId: z.string().describe('Image ID (from list_images)'),
    },
    async ({ packageName, language, imageType, imageId }) => {
      try {
        const lang = language ?? 'en-US';

        // Create an edit
        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        // Delete the image
        await client.request(
          `/applications/${packageName}/edits/${edit.id}/listings/${lang}/${imageType}/${imageId}`,
          { method: 'DELETE' }
        );

        // Commit the edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          { method: 'POST' }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Image deleted successfully.\n` +
              `Type: ${imageType}\n` +
              `Language: ${lang}\n` +
              `Image ID: ${imageId}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
