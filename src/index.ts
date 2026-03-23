#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, getConfigErrors } from './config.js';

const config = loadConfig();

if (!config) {
  const errors = getConfigErrors();
  const missing = errors.map(e => e.variable).join(', ');
  const setupMessage = `Setup required — missing: ${missing}

Set the following in your .mcp.json env block:

  "env": {
    "GPLAY_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
  }

How to get a service account key:
1. Go to Google Cloud Console > APIs & Services > Credentials
2. Create a Service Account (or use existing)
3. Create and download a JSON key for the service account
4. Go to Google Play Console > Settings > API access
5. Grant your service account access to your apps

After updating .mcp.json, restart Claude Code for changes to take effect.`;

  const server = new McpServer(
    { name: 'gplay (needs setup)', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  server.tool('gplay_setup', `Google Play MCP server is not configured. Call this tool for setup instructions.`, {}, async () => ({
    content: [{ type: 'text', text: setupMessage }],
    isError: true,
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  try {
    const server = new McpServer(
      { name: 'gplay-mcp-server', version: '1.0.0' },
      { capabilities: { logging: {} } }
    );

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

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const setupMessage = `Google Play MCP server failed to start: ${detail}

This usually means your credentials are missing or invalid.

Set the following in your .mcp.json env block:

  "env": {
    "GPLAY_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
  }

How to get a service account key:
1. Go to Google Cloud Console > APIs & Services > Credentials
2. Create a Service Account (or use existing)
3. Create and download a JSON key for the service account
4. Go to Google Play Console > Settings > API access
5. Grant your service account access to your apps

After updating .mcp.json, restart Claude Code for changes to take effect.`;

    const fallback = new McpServer(
      { name: 'gplay (needs setup)', version: '1.0.0' },
      { capabilities: { logging: {} } }
    );
    fallback.tool('gplay_setup', `Google Play MCP server is not configured. Call this tool for setup instructions.`, {}, async () => ({
      content: [{ type: 'text', text: setupMessage }],
      isError: true,
    }));
    const transport = new StdioServerTransport();
    await fallback.connect(transport);
  }
}
