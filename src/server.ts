import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BilinfoClient, type BilinfoClientOptions } from './bilinfo/client.js';
import { registerTools } from './tools/bilinfo.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: BilinfoClient;
  clientOptions?: BilinfoClientOptions;
}

let defaultClient: BilinfoClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): BilinfoClient {
  defaultClient ??= new BilinfoClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'bilinfo',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new BilinfoClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
