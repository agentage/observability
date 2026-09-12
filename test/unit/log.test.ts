import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { symbols } from 'pino';
import { createLogger } from '../../src/log.js';

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

describe('error capture', () => {
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

  it('createLogger() with no options takes the service from OTEL_SERVICE_NAME', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'agentage-auth');
    const out = capture();
    createLogger({ destination: out }).info('hi');
    expect(out.lines()[0].service).toBe('agentage-auth');
  });

  it('falls back to the deliberately loud unknown', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    const out = capture();
    createLogger({ destination: out }).info('hi');
    expect(out.lines()[0].service).toBe('unknown');
  });

  it('log.error(err) records the exception and flags the active span', () => {
    const { span, recordException } = stubSpan();
    const out = capture();
    const err = new Error('kaput');
    createLogger({ service: 'x', destination: out }).error(err);
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
    createLogger({ service: 'x', destination: out }).error({ err, userId: 'u1' });
    expect(recordException).toHaveBeenCalledWith(err);
    const [line] = out.lines();
    expect(line.msg).toBe('db down');
    expect(line.userId).toBe('u1');
  });

  it('log.error with a plain message never touches the span', () => {
    const { recordException } = stubSpan();
    const out = capture();
    createLogger({ service: 'x', destination: out }).error('rate limit hit');
    expect(recordException).not.toHaveBeenCalled();
    expect(out.lines()[0].msg).toBe('rate limit hit');
  });

  it('below error level the span is left alone', () => {
    const { recordException } = stubSpan();
    const out = capture();
    createLogger({ service: 'x', destination: out }).warn(new Error('meh'));
    expect(recordException).not.toHaveBeenCalled();
  });

  it('log.fatal(err) captures like error', () => {
    const { recordException } = stubSpan();
    const out = capture();
    createLogger({ service: 'x', destination: out }).fatal(new Error('dead'));
    expect(recordException).toHaveBeenCalledOnce();
  });

  it('is safe with no active span', () => {
    const out = capture();
    expect(() =>
      createLogger({ service: 'x', destination: out }).error(new Error('solo'))
    ).not.toThrow();
    expect(out.lines()[0].msg).toBe('solo');
  });

  it('wraps a non-Error throwable only when the caller coerces it', () => {
    const out = capture();
    createLogger({ service: 'x', destination: out }).error('string failure');
    const [line] = out.lines();
    expect(line.msg).toBe('string failure');
    expect(line.err).toBeUndefined();
  });
});

// `captureError(log, err, ctx)` was deleted for v1: this hook lifts the same fields,
// so these are its old cases asserted through `log.error`.
describe('error field lifting', () => {
  const wrappedDnsFailure = (): Error => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND backend'), { code: 'ENOTFOUND' });
    dns.stack = 'Error: getaddrinfo ENOTFOUND backend\n    at gai (/app/src/dns.ts:7:3)';
    const err = new TypeError('fetch failed', { cause: dns });
    err.stack = 'TypeError: fetch failed\n    at f (/app/node_modules/undici/index.js:1:1)';
    Object.defineProperty(err, 'fetchTarget', { value: 'GET backend/v1/ping', configurable: true });
    return err;
  };

  const withoutNoise = (line: Record<string, unknown>): Record<string, unknown> => {
    const rest = { ...line };
    delete rest.level;
    delete rest.time;
    delete rest.err;
    return rest;
  };

  it('emits the enriched line captureError produced, field for field', () => {
    const out = capture();
    createLogger({ service: 'x', destination: out }).error({
      err: wrappedDnsFailure(),
      source: 'server',
      error_code: 'TypeError',
      user_id: 'u1',
    });
    const [line] = out.lines();
    expect(withoutNoise(line)).toEqual({
      service: 'x',
      cause: 'Error: getaddrinfo ENOTFOUND backend',
      frame: 'src/dns.ts:7:3 in gai',
      target: 'GET backend/v1/ping',
      category: 'connectivity',
      error_code: 'ENOTFOUND',
      source: 'server',
      user_id: 'u1',
      msg: 'fetch failed',
    });
    expect(line.err).toMatchObject({ type: 'TypeError' });
  });

  it('lifts the same fields from a bare error as from { err, ...ctx }', () => {
    const bare = capture();
    const keyed = capture();
    createLogger({ service: 'x', destination: bare }).error(wrappedDnsFailure());
    createLogger({ service: 'x', destination: keyed }).error({ err: wrappedDnsFailure() });
    expect(withoutNoise(bare.lines()[0])).toEqual(withoutNoise(keyed.lines()[0]));
    expect(withoutNoise(bare.lines()[0])).toMatchObject({
      cause: 'Error: getaddrinfo ENOTFOUND backend',
      error_code: 'ENOTFOUND',
      category: 'connectivity',
      msg: 'fetch failed',
    });
  });

  it('keeps an application error code over the cause code', () => {
    const out = capture();
    const err = new Error('nope', {
      cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
    });
    createLogger({ service: 'x', destination: out }).error({ err, error_code: 'E_QUOTA' });
    expect(out.lines()[0].error_code).toBe('E_QUOTA');
  });

  it('carries the stack and the caller context through', () => {
    const out = capture();
    createLogger({ service: 'x', destination: out }).error({
      err: new Error('kaput'),
      userId: 'u1',
    });
    const [line] = out.lines();
    expect(line.msg).toBe('kaput');
    expect(line.userId).toBe('u1');
    expect((line.err as { stack?: string }).stack).toContain('kaput');
  });

  it('always carries a category, even when nothing else can be derived', () => {
    const out = capture();
    const err = new Error('plain');
    err.stack = 'Error: plain\n    at x (node:internal/x:1:1)';
    createLogger({ service: 'x', destination: out }).error(err);
    const [line] = out.lines();
    expect(line.category).toBe('logic');
    expect(line).not.toHaveProperty('cause');
    expect(line).not.toHaveProperty('frame');
  });

  it('leaves a below-error line unenriched', () => {
    const out = capture();
    createLogger({ service: 'x', destination: out }).warn(new Error('meh'));
    expect(out.lines()[0]).not.toHaveProperty('category');
  });
});

describe('stdio safety', () => {
  const streamOf = (log: unknown): { fd?: number } =>
    (log as Record<symbol, { fd?: number }>)[symbols.streamSym];

  it('always routes to fd 2, keeping stdout clean for JSON-RPC', () => {
    expect(streamOf(createLogger({ service: 'stdio-mcp' })).fd).toBe(2);
    expect(streamOf(createLogger({ service: 'agentage-auth' })).fd).toBe(2);
  });
});

describe('the log singleton', () => {
  const fresh = async (service?: string) => {
    vi.resetModules();
    if (service === undefined) vi.stubEnv('OTEL_SERVICE_NAME', '');
    else vi.stubEnv('OTEL_SERVICE_NAME', service);
    return import('../../src/log.js');
  };

  const stderr = (): { lines: () => Record<string, unknown>[] } => {
    const raw: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      raw.push(String(chunk));
      return true;
    });
    return {
      lines: () =>
        raw.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map((l) => JSON.parse(l)),
    };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads OTEL_SERVICE_NAME at first use, not at import', async () => {
    vi.resetModules();
    vi.stubEnv('OTEL_SERVICE_NAME', '');
    const { log } = await import('../../src/log.js');
    // The env a service loads AFTER importing the kit still wins.
    vi.stubEnv('OTEL_SERVICE_NAME', 'agentage-web');
    const out = stderr();
    log.info('hi');
    expect(out.lines()[0].service).toBe('agentage-web');
  });

  it('writes to stderr, so a stdio MCP server keeps stdout for JSON-RPC', async () => {
    const { log } = await fresh('stdio-mcp');
    const out = stderr();
    log.info({ kind: 'http' }, 'request');
    const [line] = out.lines();
    expect(line.msg).toBe('request');
    expect(line.service).toBe('stdio-mcp');
  });

  it('falls back to unknown and says so, once', async () => {
    const { log } = await fresh();
    const out = stderr();
    log.info('first');
    log.info('second');
    const lines = out.lines();
    expect(lines[0].service).toBe('unknown');
    expect(lines[0].msg).toContain('OTEL_SERVICE_NAME is not set');
    expect(lines.filter((line) => line.service_name_missing)).toHaveLength(1);
    expect(lines.map((line) => line.msg).slice(1)).toEqual(['first', 'second']);
  });

  it('is one logger, and still enriches errors and takes children', async () => {
    const { log } = await fresh('agentage-web');
    const out = stderr();
    expect(log.level).toBe('info');
    log.child({ component: 'store' }).error(new Error('kaput'));
    const [line] = out.lines();
    expect(line.component).toBe('store');
    expect(line.category).toBe('logic');
    expect(line.msg).toBe('kaput');
  });
});
