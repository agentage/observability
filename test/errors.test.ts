import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { createLogger } from '../src/logger.js';
import { captureError } from '../src/errors.js';

// The API's default context manager is a no-op, so tests stub the active span.
afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('captureError', () => {
  it('logs the error with stack and extra context', () => {
    const out = capture();
    const log = createLogger({ service: 'x', destination: out });
    captureError(log, new Error('kaput'), { userId: 'u1' });
    const [line] = out.lines();
    expect(line.msg).toBe('kaput');
    expect(line.userId).toBe('u1');
    expect((line.err as { stack?: string }).stack).toContain('kaput');
  });

  it('wraps non-Error throwables', () => {
    const out = capture();
    captureError(createLogger({ service: 'x', destination: out }), 'string failure');
    expect(out.lines()[0].msg).toBe('string failure');
  });

  it('records the exception and flags the active span as ERROR', () => {
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const span = {
      spanContext: () => ({
        traceId: 'a3ce929d0e0e4736aab7ab4f8422d25c',
        spanId: '41f9e6862b214d21',
        traceFlags: 1,
      }),
      recordException,
      setStatus,
    } as unknown as Span;
    const out = capture();
    const log = createLogger({ service: 'x', destination: out });
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
    captureError(log, new Error('kaput'));
    expect(recordException).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'kaput' });
  });

  it('lifts cause, frame and the system code onto the line', () => {
    const out = capture();
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND backend'), { code: 'ENOTFOUND' });
    dns.stack = 'Error: getaddrinfo ENOTFOUND backend\n    at gai (/app/src/dns.ts:7:3)';
    const err = new TypeError('fetch failed', { cause: dns });
    err.stack = 'TypeError: fetch failed\n    at f (/app/node_modules/undici/index.js:1:1)';
    captureError(createLogger({ service: 'x', destination: out }), err, {
      source: 'server',
      error_code: 'TypeError',
    });
    const [line] = out.lines();
    expect(line.cause).toBe('Error: getaddrinfo ENOTFOUND backend');
    expect(line.frame).toBe('src/dns.ts:7:3 in gai');
    expect(line.error_code).toBe('ENOTFOUND');
  });

  it('keeps an application error code over the cause code', () => {
    const out = capture();
    const err = new Error('nope', {
      cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
    });
    captureError(createLogger({ service: 'x', destination: out }), err, { error_code: 'E_QUOTA' });
    expect(out.lines()[0].error_code).toBe('E_QUOTA');
  });

  it('is safe with no active span', () => {
    const out = capture();
    expect(() =>
      captureError(createLogger({ service: 'x', destination: out }), new Error('solo'))
    ).not.toThrow();
    expect(out.lines()[0].msg).toBe('solo');
  });
});
