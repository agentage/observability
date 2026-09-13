// Booted by `npm run smoke:bootstrap` as `node --import ../../dist/bootstrap.js`.
// This file wires NOTHING: every assertion below is about what the bootstrap did
// to `app.listen()` through the module hook - the one path unit tests cannot take.
// It also runs with no OTEL_EXPORTER_OTLP_ENDPOINT, so it is the no-collector
// deploy: the SDK never starts and nothing registers a context manager.
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { setUser } from '../../dist/index.js';

const lines = [];
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  for (const raw of String(chunk).split('\n')) {
    try {
      lines.push(JSON.parse(raw));
    } catch {
      // Not one of ours.
    }
  }
  return writeStderr(chunk, ...rest);
};

const linesOf = (kind) => lines.filter((line) => line.kind === kind);

const app = express();

app.get('/boom', async () => {
  await Promise.resolve();
  throw new Error('ECONNREFUSED 10.0.0.4:5432 internal detail');
});

app.get('/me', async (_req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  setUser('user_1');
  res.json({ ok: true });
});

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200, 'GET /health should be auto-mounted');
assert.equal((await health.json()).data.status, 'ok');

assert.equal((await fetch(`${base}/api/health`)).status, 200, 'GET /api/health too');

const boom = await fetch(`${base}/boom`);
assert.equal(boom.status, 500);
assert.deepEqual(
  await boom.json(),
  {
    success: false,
    error: { code: 'Error', message: 'Internal server error' },
    traceId: '',
  },
  'a 500 must not leak the thrown message'
);
const errorLine = lines.find((line) => line.source === 'server');
assert.ok(errorLine, 'the 500 should emit one ErrorEvent');
assert.equal(
  errorLine.err.message,
  'ECONNREFUSED 10.0.0.4:5432 internal detail',
  'the logged line keeps the full message'
);

assert.equal((await fetch(`${base}/me`)).status, 200);
const http = linesOf('http');
assert.equal(http.length, 2, 'one request line per request, /boom and /me');
assert.equal(http[1].path, '/me');
assert.equal(http[1].user_id, 'user_1', 'setUser must work with no tracing SDK started');

server.close();

// The MCP SDK, imported like any service imports it: the tool below is
// registered with zero observability code, so a `kind:'tool'` line proves the
// module hook reached the SDK.
const mcp = new McpServer({ name: 'bootstrap-smoke', version: '0.0.0' });
mcp.registerTool('memory__write', { inputSchema: { path: z.string(), body: z.string() } }, () => ({
  content: [{ type: 'text', text: 'written' }],
}));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'bootstrap-smoke-client', version: '0.0.0' });
await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);

await client.callTool({ name: 'memory__write', arguments: { path: 'a.md', body: 'hello' } });
await client.close();
process.stderr.write = writeStderr;

const toolLine = lines.find((line) => line.kind === 'tool');
assert.ok(toolLine, 'the MCP tool call should emit one kind:tool line');
assert.equal(toolLine.tool, 'memory__write');
assert.equal(toolLine.status, 'ok');
assert.equal(typeof toolLine.duration_ms, 'number');

console.log('bootstrap smoke ok');
