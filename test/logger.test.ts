import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { symbols } from 'pino';
import { createLogger } from '../src/logger.js';

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
