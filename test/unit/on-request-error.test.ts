import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onRequestError } from '../../src/next.js';
import { log } from '../../src/log.js';

const lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines.length = 0;
  vi.stubEnv('OTEL_SERVICE_NAME', 'next-error-test');
  // The singleton is a lazy Proxy, so `vi.spyOn(log, 'error')` no-ops - assert on
  // the bytes it writes instead. This is the pattern the README hands consumers.
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Not one of ours.
      }
    }
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const REQUEST = { path: '/memories/abc', method: 'GET' };
const CONTEXT = { routerKind: 'App Router', routePath: '/memories/[id]', routeType: 'render' };

describe('onRequestError value form', () => {
  it('logs the ErrorEvent when Next calls it directly', () => {
    // The trap this exists for: `export { onRequestError } from '.../next'`.
    const handler: unknown = onRequestError;
    (handler as (...args: unknown[]) => void)(new Error('render blew up'), REQUEST, CONTEXT);
    const line = lines.find((entry) => entry.source === 'server');
    expect(line).toMatchObject({
      route: '/memories/[id]',
      method: 'GET',
      status: 500,
      router_kind: 'App Router',
      route_type: 'render',
      msg: 'render blew up',
    });
  });

  it('falls back to the request path when Next reports no route', () => {
    (onRequestError as (...args: unknown[]) => void)(new Error('boom'), REQUEST, {});
    expect(lines.find((entry) => entry.source === 'server')?.route).toBe('/memories/abc');
  });

  it('handles a thrown non-Error', () => {
    (onRequestError as (...args: unknown[]) => void)('just a string', REQUEST, CONTEXT);
    expect(lines.find((entry) => entry.source === 'server')?.msg).toBe('just a string');
  });
});

describe('onRequestError factory form', () => {
  it('still binds a logger passed as the only argument', () => {
    const handler = onRequestError(log);
    expect(typeof handler).toBe('function');
    expect(lines).toHaveLength(0);
    handler(new Error('bound'), REQUEST, CONTEXT);
    expect(lines.find((entry) => entry.source === 'server')?.msg).toBe('bound');
  });

  it('accepts any logger-like double', () => {
    const error = vi.fn();
    const child = vi.fn();
    const handler = onRequestError({ error, child } as never);
    handler(new Error('double'), REQUEST, CONTEXT);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toMatchObject({ status: 500, source: 'server' });
  });

  it('treats a lone non-logger argument as a thrown error, not a logger', () => {
    (onRequestError as (...args: unknown[]) => void)(new Error('lonely'));
    expect(lines.find((entry) => entry.source === 'server')?.msg).toBe('lonely');
  });
});
