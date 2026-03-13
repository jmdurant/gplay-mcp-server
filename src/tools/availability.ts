import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface AppEdit {
  id: string;
}

interface TrackTargetedCountry {
  countryCode: string;
}

interface TrackCountryAvailability {
  countries: TrackTargetedCountry[];
  restOfWorld: boolean;
  syncWithProduction: boolean;
}

interface ConvertedRegionPrice {
  regionCode: string;
  price: {
    priceMicros: string;
    currencyCode: string;
  };
  taxInclusivePrice?: {
    priceMicros: string;
    currencyCode: string;
  };
}

interface ConvertRegionPricesResponse {
  convertedRegionPrices: Record<string, {
    priceMicros: string;
    currencyCode: string;
  }>;
  convertedOtherRegionsPrice?: {
    eurPrice: { priceMicros: string; currencyCode: string };
    usdPrice: { priceMicros: string; currencyCode: string };
  };
}

export function registerAvailabilityTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'get_country_availability',
    'Get country/region availability for an app on a specific track. Shows which countries the app is available in.',
    {
      packageName: z.string().describe('Android package name (e.g. "com.example.app")'),
      track: z.enum(['internal', 'alpha', 'beta', 'production']).optional().describe('Track to check (default: production)'),
    },
    async ({ packageName, track }) => {
      try {
        const targetTrack = track ?? 'production';

        const edit = await client.request<AppEdit>(
          `/applications/${packageName}/edits`,
          { method: 'POST', body: {} }
        );

        const availability = await client.request<TrackCountryAvailability>(
          `/applications/${packageName}/edits/${edit.id}/countryAvailability/${targetTrack}`
        );

        // Clean up the edit
        await client.request(
          `/applications/${packageName}/edits/${edit.id}`,
          { method: 'DELETE' }
        );

        const countries = availability.countries ?? [];
        const countryCodes = countries.map(c => c.countryCode).sort();

        return {
          content: [{
            type: 'text' as const,
            text: `Country availability for ${packageName} (${targetTrack} track)\n` +
              `${'='.repeat(50)}\n` +
              `Sync with production: ${availability.syncWithProduction}\n` +
              `Rest of world: ${availability.restOfWorld}\n` +
              `Targeted countries (${countryCodes.length}): ${countryCodes.join(', ') || 'none'}\n\n` +
              JSON.stringify(availability, null, 2),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'convert_region_prices',
    'Convert a base price to regional prices for all Google Play regions. Useful for pricing in-app products and subscriptions across markets.',
    {
      packageName: z.string().describe('Android package name'),
      priceMicros: z.string().describe('Price in micros (e.g. "990000" for $0.99, "4990000" for $4.99)'),
      currencyCode: z.string().optional().describe('Currency code (default: USD)'),
    },
    async ({ packageName, priceMicros, currencyCode }) => {
      try {
        const currency = currencyCode ?? 'USD';

        const result = await client.request<ConvertRegionPricesResponse>(
          `/applications/${packageName}/pricing:convertRegionPrices`,
          {
            method: 'POST',
            body: {
              price: {
                priceMicros,
                currencyCode: currency,
              },
            },
          }
        );

        const regionCount = Object.keys(result.convertedRegionPrices ?? {}).length;

        // Format prices for readability
        const formatted = Object.entries(result.convertedRegionPrices ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([region, price]) => {
            const amount = (Number(price.priceMicros) / 1_000_000).toFixed(2);
            return `  ${region}: ${amount} ${price.currencyCode}`;
          })
          .join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Regional prices for ${packageName}\n` +
              `Base price: ${(Number(priceMicros) / 1_000_000).toFixed(2)} ${currency}\n` +
              `Converted to ${regionCount} regions:\n\n` +
              formatted +
              (result.convertedOtherRegionsPrice ? `\n\nOther regions:\n  EUR: ${(Number(result.convertedOtherRegionsPrice.eurPrice.priceMicros) / 1_000_000).toFixed(2)}\n  USD: ${(Number(result.convertedOtherRegionsPrice.usdPrice.priceMicros) / 1_000_000).toFixed(2)}` : ''),
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
