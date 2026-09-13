import { describe, it, expect, beforeEach } from 'vitest';
import { collectorRoute } from '../../src/next.js';
import { createLogger } from '../../src/log.js';

const lines: Record<string, unknown>[] = [];

const log = createLogger({
  service: 'collector-route-test',
  destination: {
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  },
});

const TRACE_ID = 'a3ce929d0e0e4736aab7ab4f8422d25c';

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt_1',
  ts: '2026-09-14T10:00:00.000Z',
  err: { type: 'TypeError', message: 'x is not a function', stack: 'at a\nat b' },
  route: '/memories',
  service: 'agentage-dashboard',
  url: 'https://app.agentage.io/memories',
  ...overrides,
});

const post = (
  body: unknown,
  headers: Record<string, string> = { origin: 'https://app.agentage.io' }
): Request =>
  new Request('https://app.agentage.io/api/client-errors', {
    method: 'POST',
    // sendBeacon's content type, which is what the browser reporter actually sends.
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  lines.length = 0;
});

describe('collectorRoute', () => {
  it('logs a whitelisted client event and answers 204', async () => {
    const res = await collectorRoute({ log })(post({ events: [event({ trace_id: TRACE_ID })] }));
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      source: 'client',
      service: 'agentage-dashboard',
      route: '/memories',
      error_code: 'TypeError',
      trace_id: TRACE_ID,
      msg: 'x is not a function',
    });
    expect((lines[0].err as { message: string }).message).toBe('x is not a function');
  });

  it('drops a trace_id that is not 32 hex', async () => {
    await collectorRoute({ log })(post({ events: [event({ trace_id: 'not-a-trace-id' })] }));
    expect(lines[0].trace_id).toBeUndefined();
  });

  it('never forwards an unknown key or a client-declared source', async () => {
    await collectorRoute({ log })(
      post({ events: [event({ source: 'server', admin: true, cookie: 'x' })] })
    );
    expect(lines[0].source).toBe('client');
    expect(lines[0].admin).toBeUndefined();
    expect(lines[0].cookie).toBeUndefined();
  });

  it('answers 204 for an unparseable body, and logs nothing', async () => {
    const res = await collectorRoute({ log })(post('not json'));
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(0);
  });

  it('caps the events it logs instead of rejecting the request', async () => {
    const events = Array.from({ length: 25 }, (_, i) => event({ event_id: `evt_${i}` }));
    const res = await collectorRoute({ log })(post({ events }));
    expect(res.status).toBe(204);
    expect(lines).toHaveLength(20);
  });

  it('accepts a same-origin post whose Origin matches the forwarded host', async () => {
    const request = new Request('http://10.0.0.7:3000/api/client-errors', {
      method: 'POST',
      headers: {
        origin: 'https://app.agentage.io',
        host: '10.0.0.7:3000',
        'x-forwarded-host': 'app.agentage.io, edge.internal',
      },
      body: JSON.stringify({ events: [event()] }),
    });
    expect((await collectorRoute({ log })(request)).status).toBe(204);
  });

  it('rejects a cross-origin post', async () => {
    const res = await collectorRoute({ log })(
      post({ events: [event()] }, { origin: 'https://evil.example' })
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(lines).toHaveLength(0);
  });

  it('accepts a listed foreign origin', async () => {
    const route = collectorRoute({ log, allowOrigins: ['https://admin.agentage.io'] });
    const res = await route(post({ events: [event()] }, { origin: 'https://admin.agentage.io' }));
    expect(res.status).toBe(204);
  });

  it('rejects a missing Origin unless it declares same-site or is opted in', async () => {
    const body = { events: [event()] };
    expect((await collectorRoute({ log })(post(body, {}))).status).toBe(403);
    expect(
      (await collectorRoute({ log })(post(body, { 'sec-fetch-site': 'same-origin' }))).status
    ).toBe(204);
    expect((await collectorRoute({ log, allowMissingOrigin: true })(post(body, {}))).status).toBe(
      204
    );
  });

  it('rejects an oversized body by header and by what it actually read', async () => {
    const route = collectorRoute({ log, maxBodyBytes: 64 });
    const declared = await route(
      post({ events: [event()] }, { origin: 'https://app.agentage.io', 'content-length': '99999' })
    );
    expect(declared.status).toBe(413);
    expect((await route(post({ events: [event()] }))).status).toBe(413);
    expect(lines).toHaveLength(0);
  });

  it('rate limits with a sliding window and answers 429', async () => {
    const route = collectorRoute({ log, rateLimit: { limit: 2, windowMs: 60_000 } });
    const body = { events: [event()] };
    expect((await route(post(body))).status).toBe(204);
    expect((await route(post(body))).status).toBe(204);
    expect((await route(post(body))).status).toBe(429);
  });

  it('answers 405 with Allow for a non-POST', async () => {
    const res = await collectorRoute({ log })(
      new Request('https://app.agentage.io/api/client-errors', { method: 'GET' })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('reads OTEL_CLIENT_ERROR_ORIGINS when no origins are passed', async () => {
    process.env.OTEL_CLIENT_ERROR_ORIGINS = 'https://admin.agentage.io';
    try {
      const res = await collectorRoute({ log })(
        post({ events: [event()] }, { origin: 'https://admin.agentage.io' })
      );
      expect(res.status).toBe(204);
    } finally {
      delete process.env.OTEL_CLIENT_ERROR_ORIGINS;
    }
  });
});
