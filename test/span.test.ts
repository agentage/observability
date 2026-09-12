import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { span, withSpan } from '../src/span.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeTracer() {
  const span = {
    recordException: vi.fn(),
    setStatus: vi.fn(),
    setAttribute: vi.fn(),
    end: vi.fn(),
  };
  const tracer = {
    startActiveSpan: vi.fn((_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn(span)),
  };
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer as never);
  return { span, tracer };
}

describe('span', () => {
  it('returns the value and ends the span', async () => {
    const { span: started, tracer } = fakeTracer();
    await expect(span('store.read', () => 42, { memory: 'm1' })).resolves.toBe(42);
    expect(tracer.startActiveSpan).toHaveBeenCalledWith(
      'store.read',
      { attributes: { memory: 'm1' } },
      expect.any(Function)
    );
    expect(started.end).toHaveBeenCalledOnce();
  });

  it('records the exception, flags ERROR, rethrows, still ends', async () => {
    const { span: started } = fakeTracer();
    await expect(
      span('store.write', () => {
        throw new Error('kaput');
      })
    ).rejects.toThrow('kaput');
    expect(started.recordException).toHaveBeenCalledOnce();
    expect(started.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(started.end).toHaveBeenCalledOnce();
  });

  it('is safe with the noop tracer (no SDK)', async () => {
    await expect(span('noop', async () => 'ok')).resolves.toBe('ok');
  });

  it('still answers to its old name', () => {
    expect(withSpan).toBe(span);
  });
});
