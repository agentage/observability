import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { withSpan } from '../src/with-span.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeTracer() {
  const span = {
    recordException: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn((_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn(span)),
  };
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
  return { span, tracer };
}

describe('withSpan', () => {
  it('returns the value and ends the span', async () => {
    const { span, tracer } = fakeTracer();
    await expect(withSpan('store.read', () => 42, { memory: 'm1' })).resolves.toBe(42);
    expect(tracer.startActiveSpan).toHaveBeenCalledWith(
      'store.read',
      { attributes: { memory: 'm1' } },
      expect.any(Function)
    );
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('records the exception, flags ERROR, rethrows, still ends', async () => {
    const { span } = fakeTracer();
    await expect(
      withSpan('store.write', () => {
        throw new Error('kaput');
      })
    ).rejects.toThrow('kaput');
    expect(span.recordException).toHaveBeenCalledOnce();
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('is safe with the noop tracer (no SDK)', async () => {
    await expect(withSpan('noop', async () => 'ok')).resolves.toBe('ok');
  });
});
