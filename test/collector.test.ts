import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';
import {
  collectorHandler,
  parseClientEvents,
  type CollectorRequest,
  type CollectorResponse,
} from '../src/collector.js';

function capture(): { lines: () => Record<string, unknown>[]; write: (msg: string) => void } {
  const raw: string[] = [];
  return {
    lines: () =>
      raw.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map((l) => JSON.parse(l)),
    write: (msg: string) => {
      raw.push(msg);
    },
  };
}

function res(): CollectorResponse & { code?: number } {
  const r = {
    code: undefined as number | undefined,
    status(code: number) {
      r.code = code;
      return r;
    },
    end() {
      return undefined;
    },
  };
  return r;
}

const event = (message: string): Record<string, unknown> => ({
  event_id: 'e1',
  ts: '2026-08-12T10:00:00.000Z',
  err: { type: 'TypeError', message, stack: 'TypeError: x\n at y' },
  route: '/dashboard',
  source: 'client',
  service: 'web',
  url: 'https://app.test/dashboard',
  user_agent: 'test-agent/1.0',
  user_id: 'u1',
});

const post = (body: unknown, headers: Record<string, string> = {}): CollectorRequest => ({
  method: 'POST',
  headers: { origin: 'https://app.test', ...headers },
  body,
});

describe('parseClientEvents', () => {
  it('accepts a raw JSON string body (sendBeacon posts text/plain)', () => {
    const events = parseClientEvents(JSON.stringify({ events: [event('boom')] }));
    expect(events).toHaveLength(1);
    expect(events[0].err.message).toBe('boom');
  });

  it('accepts a bare array and returns [] for junk', () => {
    expect(parseClientEvents([event('a')])).toHaveLength(1);
    expect(parseClientEvents('not json')).toEqual([]);
    expect(parseClientEvents({ events: 'nope' })).toEqual([]);
    expect(parseClientEvents({ events: [null, 7, { err: {} }] })).toEqual([]);
  });

  it('drops unknown keys and forces source client', () => {
    const [parsed] = parseClientEvents({
      events: [{ ...event('boom'), source: 'server', admin: true, cookie: 'secret' }],
    });
    expect(parsed.source).toBe('client');
    expect(Object.keys(parsed).sort()).toEqual(
      ['err', 'event_id', 'route', 'service', 'source', 'ts', 'url', 'user_agent', 'user_id'].sort()
    );
  });

  it('truncates long messages but keeps a real stack', () => {
    const stack = `Error: x\n${'    at frame\n'.repeat(50)}`;
    const [parsed] = parseClientEvents({
      events: [{ err: { type: 'Error', message: 'm'.repeat(500), stack } }],
    });
    expect(parsed.err.message).toHaveLength(203);
    expect(parsed.err.stack).toBe(stack);
    expect(parsed.service).toBe('unknown');
  });
});

describe('collectorHandler', () => {
  it('logs each event as an error line and answers 204', () => {
    const out = capture();
    const log = createLogger({ service: 'collector', destination: out });
    const response = res();
    collectorHandler(log, { allowOrigins: ['https://app.test'] })(
      post({ events: [event('boom')] }),
      response
    );
    expect(response.code).toBe(204);
    const [line] = out.lines();
    expect(line.level).toBe(50);
    expect(line.msg).toBe('boom');
    expect(line.source).toBe('client');
    expect(line.route).toBe('/dashboard');
    expect(line.user_id).toBe('u1');
    expect(line.err).toEqual({ type: 'TypeError', message: 'boom', stack: 'TypeError: x\n at y' });
    expect(line.error_code).toBe('TypeError');
    // The reporting app owns the line, not the collector that relayed it.
    expect(line.service).toBe('web');
  });

  it('rejects a foreign or missing origin with 403', () => {
    const out = capture();
    const handler = collectorHandler(createLogger({ service: 'c', destination: out }), {
      allowOrigins: ['https://app.test'],
    });
    const foreign = res();
    handler(post({ events: [event('boom')] }, { origin: 'https://evil.test' }), foreign);
    expect(foreign.code).toBe(403);
    const missing = res();
    handler({ method: 'POST', headers: {}, body: { events: [event('boom')] } }, missing);
    expect(missing.code).toBe(403);
    expect(out.lines()).toHaveLength(0);
  });

  it('accepts any origin with the wildcard and rejects non-POST', () => {
    const out = capture();
    const handler = collectorHandler(createLogger({ service: 'c', destination: out }), {
      allowOrigins: ['*'],
    });
    const wild = res();
    handler(post({ events: [event('boom')] }, { origin: 'https://any.test' }), wild);
    expect(wild.code).toBe(204);
    const get = res();
    handler({ method: 'GET', headers: {} }, get);
    expect(get.code).toBe(405);
  });

  it('rejects an oversized body with 413', () => {
    const out = capture();
    const response = res();
    collectorHandler(createLogger({ service: 'c', destination: out }), {
      allowOrigins: ['https://app.test'],
      maxBodyBytes: 100,
    })(post({ events: [event('boom')] }, { 'content-length': '101' }), response);
    expect(response.code).toBe(413);
    expect(out.lines()).toHaveLength(0);
  });

  it('caps the events it logs per request', () => {
    const out = capture();
    const response = res();
    const events = Array.from({ length: 5 }, (_, i) => event(`boom-${i}`));
    collectorHandler(createLogger({ service: 'c', destination: out }), {
      allowOrigins: ['https://app.test'],
      maxEventsPerRequest: 2,
    })(post({ events }), response);
    expect(response.code).toBe(204);
    expect(out.lines().map((l) => l.msg)).toEqual(['boom-0', 'boom-1']);
  });
});
