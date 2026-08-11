import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { symbols } from 'pino';
import { createLogger, logger } from '../src/logger.js';

// The API's default context manager is a no-op, so tests stub the active span
// instead of registering a real AsyncLocalStorage manager.
afterEach(() => {
  vi.restoreAllMocks();
});

const SPAN_CONTEXT = {
  traceId: 'a3ce929d0e0e4736aab7ab4f8422d25c',
  spanId: '41f9e6862b214d21',
  traceFlags: 1,
};

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

describe('createLogger', () => {
  it('writes JSON lines carrying the service name', () => {
    const out = capture();
    const log = createLogger({ service: 'agentage-auth', destination: out });
    log.info({ route: '/health' }, 'probe');
    const [line] = out.lines();
    expect(line.service).toBe('agentage-auth');
    expect(line.msg).toBe('probe');
    expect(line.route).toBe('/health');
  });

  it('omits trace ids when no span is active', () => {
    const out = capture();
    createLogger({ service: 'x', destination: out }).info('no span');
    const [line] = out.lines();
    expect(line.trace_id).toBeUndefined();
    expect(line.span_id).toBeUndefined();
  });

  it('injects trace_id/span_id from the active span context', () => {
    const out = capture();
    const log = createLogger({ service: 'x', destination: out });
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(trace.wrapSpanContext(SPAN_CONTEXT));
    log.error('boom');
    const [line] = out.lines();
    expect(line.trace_id).toBe(SPAN_CONTEXT.traceId);
    expect(line.span_id).toBe(SPAN_CONTEXT.spanId);
  });

  it('respects the level option', () => {
    const out = capture();
    const log = createLogger({ service: 'x', level: 'warn', destination: out });
    log.info('dropped');
    log.warn('kept');
    const lines = out.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe('kept');
  });
});

describe('simple API', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const stubSpan = (): { span: Span; recordException: ReturnType<typeof vi.fn> } => {
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
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
    return { span, recordException };
  };

  it('logger is createLogger under the health()-style name', () => {
    expect(logger).toBe(createLogger);
  });

  it('logger() with no options takes the service from OTEL_SERVICE_NAME', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'agentage-auth');
    const out = capture();
    logger({ destination: out }).info('hi');
    expect(out.lines()[0].service).toBe('agentage-auth');
  });

  it('falls back to the deliberately loud unknown', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    const out = capture();
    logger({ destination: out }).info('hi');
    expect(out.lines()[0].service).toBe('unknown');
  });

  it('log.error(err) records the exception and flags the active span', () => {
    const { span, recordException } = stubSpan();
    const out = capture();
    const err = new Error('kaput');
    logger({ service: 'x', destination: out }).error(err);
    expect(recordException).toHaveBeenCalledWith(err);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'kaput' });
    const [line] = out.lines();
    expect(line.msg).toBe('kaput');
    expect((line.err as { stack?: string }).stack).toContain('kaput');
  });

  it('log.error({ err, ...ctx }) captures too and defaults the message', () => {
    const { recordException } = stubSpan();
    const out = capture();
    const err = new Error('db down');
    logger({ service: 'x', destination: out }).error({ err, userId: 'u1' });
    expect(recordException).toHaveBeenCalledWith(err);
    const [line] = out.lines();
    expect(line.msg).toBe('db down');
    expect(line.userId).toBe('u1');
  });

  it('log.error with a plain message never touches the span', () => {
    const { recordException } = stubSpan();
    const out = capture();
    logger({ service: 'x', destination: out }).error('rate limit hit');
    expect(recordException).not.toHaveBeenCalled();
    expect(out.lines()[0].msg).toBe('rate limit hit');
  });

  it('below error level the span is left alone', () => {
    const { recordException } = stubSpan();
    const out = capture();
    logger({ service: 'x', destination: out }).warn(new Error('meh'));
    expect(recordException).not.toHaveBeenCalled();
  });

  it('log.fatal(err) captures like error', () => {
    const { recordException } = stubSpan();
    const out = capture();
    logger({ service: 'x', destination: out }).fatal(new Error('dead'));
    expect(recordException).toHaveBeenCalledOnce();
  });

  it('is safe with no active span', () => {
    const out = capture();
    expect(() => logger({ service: 'x', destination: out }).error(new Error('solo'))).not.toThrow();
    expect(out.lines()[0].msg).toBe('solo');
  });
});

describe('stdio safety', () => {
  const streamOf = (log: unknown): { fd?: number } =>
    (log as Record<symbol, { fd?: number }>)[symbols.streamSym];

  it('stream stderr routes to fd 2, keeping stdout clean for JSON-RPC', () => {
    expect(streamOf(createLogger({ service: 'stdio-mcp', stream: 'stderr' })).fd).toBe(2);
  });

  it('defaults to stdout for HTTP services', () => {
    expect(streamOf(createLogger({ service: 'agentage-auth' })).fd).toBe(1);
  });
});
