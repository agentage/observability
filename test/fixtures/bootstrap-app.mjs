// Booted by `npm run smoke:bootstrap` as `node --import ../../dist/bootstrap.js`.
// This file wires NOTHING: every assertion below is about what the bootstrap did
// to `app.listen()` through the module hook - the one path unit tests cannot take.
import assert from 'node:assert/strict';
import express from 'express';

const app = express();

app.get('/boom', async () => {
  await Promise.resolve();
  throw new Error('kaboom');
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
assert.deepEqual(await boom.json(), {
  success: false,
  error: { code: 'Error', message: 'kaboom' },
  traceId: '',
});

const failed = await fetch('http://127.0.0.1:1/nothing').catch((err) => err);
assert.equal(failed.fetchTarget, 'GET 127.0.0.1:1/nothing', 'the global fetch is enriched');

server.close();
console.log('bootstrap smoke ok');
