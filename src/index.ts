#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, getConfigErrors } from './config.js';

const config = loadConfig();

const server = new McpServer(
  { name: 'gplay-mcp-server', version: '1.0.0' },
  {
    capabilities: { logging: {} },
    ...(!config && {
      instructions: 'Google Play MCP Server — setup required. Run the "setup" tool for configuration instructions.',
    }),
  }
);

if (config) {
  // Config is valid — register all normal tools
  const { GooglePlayClient } = await import('./client.js');
  const { registerAppTools } = await import('./tools/apps.js');
  const { registerBuildTools } = await import('./tools/builds.js');
  const { registerTestingTools } = await import('./tools/testing.js');
  const { registerReviewTools } = await import('./tools/reviews.js');
  const { registerListingTools } = await import('./tools/listings.js');
  const { registerScreenshotTools } = await import('./tools/screenshots.js');
  const { registerPreflightTools } = await import('./tools/preflight.js');
  const { registerAvailabilityTools } = await import('./tools/availability.js');

  const client = new GooglePlayClient(config);

  registerAppTools(server, client);
  registerBuildTools(server, client);
  registerTestingTools(server, client);
  registerReviewTools(server, client);
  registerListingTools(server, client);
  registerScreenshotTools(server, client);
  registerPreflightTools(server, client);
  registerAvailabilityTools(server, client);
} else {
  // Config is missing — register only the setup tool
  server.tool(
    'setup',
    'Show setup instructions for the Google Play MCP server',
    {},
    async () => {
      const errors = getConfigErrors();

      const envVars: Record<string, { required: boolean; description: string }> = {
        GPLAY_SERVICE_ACCOUNT_KEY: {
          required: true,
          description: 'Absolute path to Google Cloud service account JSON key file',
        },
      };

      const statusLines: string[] = [];
      for (const [name, info] of Object.entries(envVars)) {
        const value = process.env[name];
        const errorEntry = errors.find(e => e.variable === name);
        if (errorEntry) {
          statusLines.push(`  ${name}: MISSING — ${errorEntry.message}`);
        } else if (value) {
          statusLines.push(`  ${name}: Set (${value})`);
        } else {
          statusLines.push(`  ${name}: Not set${info.required ? ' (REQUIRED)' : ' (optional)'}`);
        }
      }

      const missingList = errors.map(e => `- ${e.variable}: ${e.message}`).join('\n');

      const message = `Google Play MCP Server - Setup Required

This server needs the following environment variable configured in your Claude settings (~/.claude/settings.json):

"google-play": {
  "command": "node",
  "args": ["/Users/jamesdurant/gplay-mcp-server/dist/index.js"],
  "env": {
    "GPLAY_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
  }
}

How to get these values:
1. Go to Google Cloud Console → APIs & Services → Credentials
2. Create a Service Account (or use existing)
3. Create and download a JSON key for the service account
4. Go to Google Play Console → Settings → API access
5. Grant your service account access to your apps

Environment variable status:
${statusLines.join('\n')}

Missing:
${missingList}

After updating settings, restart Claude Code for changes to take effect.`;

      return { content: [{ type: 'text' as const, text: message }] };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
