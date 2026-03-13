#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { GooglePlayClient } from './client.js';
import { registerAppTools } from './tools/apps.js';
import { registerBuildTools } from './tools/builds.js';
import { registerTestingTools } from './tools/testing.js';
import { registerReviewTools } from './tools/reviews.js';

const config = loadConfig();
const client = new GooglePlayClient(config);

const server = new McpServer(
  { name: 'gplay-mcp-server', version: '1.0.0' },
  { capabilities: { logging: {} } }
);

registerAppTools(server, client);
registerBuildTools(server, client);
registerTestingTools(server, client);
registerReviewTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
