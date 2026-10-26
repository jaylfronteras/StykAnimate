#!/usr/bin/env node
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {start} from './server.js';

const {stop} = await start(new StdioServerTransport());
const shutdown = () => { void stop().finally(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
