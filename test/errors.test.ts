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

  it('is safe with no active span', () => {
    const out = capture();
    expect(() =>
      captureError(createLogger({ service: 'x', destination: out }), new Error('solo'))
    ).not.toThrow();
    expect(out.lines()[0].msg).toBe('solo');
  });
});
