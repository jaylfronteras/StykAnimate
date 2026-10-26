import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {registerTools, shutdown} from './tools.js';

export function createServer() {
  const server = new McpServer({name: 'stykanimate', version: '1.0.0'});
  registerTools(server);
  return server;
}

export async function start(transport) {
  const server = createServer();
  await server.connect(transport);
  const stop = async () => {
    await shutdown();
    await server.close();
  };
  return {server, stop};
}
