import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import type express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { observeBrowser } from '../src/browser.js';
import { samplerFromTraceEnv } from '../src/internal/tracer.js';

const exporter = new InMemorySpanExporter();
const globals = globalThis as unknown as Record<string, unknown>;
let server: Server;
let base: string;

/** A traceparent minted by the real browser lane, captured off its patched fetch. */
function browserTraceparent(): string {
  let captured = '';
  const realFetch = globals.fetch;
  globals.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { pathname: '/dashboard', href: 'https://app.test/dashboard' },
  };
  globals.fetch = (_input: unknown, init?: Record<string, unknown>) => {
    captured = (init?.headers as Record<string, string>).traceparent;
    return Promise.resolve({});
  };
  const stop = observeBrowser({ endpoint: '/api/client-errors', service: 'web' });
  void (globals.fetch as (i: string, x?: Record<string, unknown>) => Promise<unknown>)('/api/x');
  stop();
  delete globals.window;
  globals.fetch = realFetch;
  return captured;
}

beforeAll(async () => {
  const provider = new NodeTracerProvider({
    // The estate's production sampler at its harshest: keep nothing on our own.
    sampler: samplerFromTraceEnv({
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0',
    }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new HttpInstrumentation()],
  });

  // Required after the hook is registered, so http and express load patched.
  const require = createRequire(import.meta.url);
  require('http');
  const app = (require('express') as typeof express)();
  app.get('/api/memories', (_req, res) => {
    res.status(200).end();
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
});

const get = async (headers: Record<string, string> = {}): Promise<ReadableSpan[]> => {
  exporter.reset();
  const res = await fetch(`${base}/api/memories`, { headers });
  expect(res.status).toBe(200);
  return exporter.getFinishedSpans();
};

describe('a browser-minted traceparent upgrades sampling', () => {
  it('keeps the browser trace id and its sampled flag at ratio 0', async () => {
    const traceparent = browserTraceparent();
    const [, traceId, spanId] = traceparent.split('-');
    const spans = await get({ traceparent });
    expect(spans).toHaveLength(1);
    expect(spans[0].spanContext().traceId).toBe(traceId);
    expect(spans[0].parentSpanContext?.spanId).toBe(spanId);
    // ParentBased honours the inbound flag: a real user action is traced whole.
    expect(spans[0].spanContext().traceFlags).toBe(1);
  });

  it('records nothing for the same request without one', async () => {
    expect(await get()).toHaveLength(0);
  });
});
