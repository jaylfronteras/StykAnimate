import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../src/server.js';
import {resetStore} from '../src/session.js';

// Also set here so `node --test test/<file>.test.mjs` stays on the rasterizer
// when the npm script's --import preload is not used.
process.env.STYK_RENDER = 'software';

export async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'styk-mcp-'));
  process.env.STYK_WORKSPACE = dir;
  resetStore();
  return dir;
}

export async function connect() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({name: 'stykanimate-mcp-test', version: '1.0.0'});
  await client.connect(clientTransport);
  return {client, server};
}

export async function call(client, name, args = {}) {
  const result = await client.callTool({name, arguments: args});
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  if (result.isError) {
    const error = new Error(text);
    error.isError = true;
    throw error;
  }
  return {data: text ? JSON.parse(text) : null, images: (result.content ?? []).filter(item => item.type === 'image')};
}

export function ink(png) {
  return png.length;
}

export async function fail(client, name, args = {}) {
  const result = await client.callTool({name, arguments: args});
  if (!result.isError) throw new Error(`${name} was expected to fail`);
  return result.content?.find(item => item.type === 'text')?.text ?? '';
}
