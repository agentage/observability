// Booted by `npm run smoke:stdio`. Spawns a child under the bootstrap WITH an OTLP
// endpoint configured - the production shape, and the only one that printed the ready
// banner - and asserts the child's stdout is byte-for-byte what the child itself
// wrote. A stdio MCP server speaks JSON-RPC on that stream: one extra line is a
// protocol error, and `server-memory` and `cli` both shipped a stdout diversion around
// the bootstrap import to work around it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(
  process.execPath,
  [
    '--import',
    fileURLToPath(new URL('../../dist/bootstrap.js', import.meta.url)),
    fileURLToPath(new URL('./stdio-child.mjs', import.meta.url)),
  ],
  {
    env: {
      ...process.env,
      OTEL_SERVICE_NAME: 'stdio-smoke',
      // Nothing listens here: the exporter must fail quietly, on stderr or not at all.
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_LOG_LEVEL: 'info',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));

const code = await new Promise((resolve) => child.once('close', resolve));

assert.equal(code, 0, `child exited ${code}\n${stderr}`);
assert.equal(
  stdout,
  '{"jsonrpc":"2.0","id":1,"result":{}}\n',
  `the bootstrap wrote to stdout:\n${stdout}`
);
// The banner still has to be somewhere - a silent kit is not the fix.
assert.match(stderr, /otel: tracing enabled - service stdio-smoke/);

console.log('stdio smoke ok');
