import { describe, it, expect, vi, afterEach } from 'vitest';
import { context as otelContext, trace } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { setUser } from '../src/user.js';
import { span } from '../src/span.js';
import { createRequestLog, type RequestLogRequest } from '../src/internal/patch/request-log.js';
import {
  errorMiddleware,
  onRequestError,
  type ErrorResponse,
} from '../src/internal/patch/error-emitters.js';
import { useAsyncContextManager, useStackContextManager } from './stack-context-manager.js';

afterEach(() => {
  otelContext.disable();
  vi.restoreAllMocks();
});

type LogRecord = Record<string, unknown>;

/** Drives one request through the middleware and returns the emitted line. */
const request = (
  handler: () => void,
  req: Partial<RequestLogRequest> & LogRecord = {},
  options?: Parameters<typeof createRequestLog>[1]
): LogRecord => {
  const info = vi.fn();
  let finish: () => void = () => {};
  createRequestLog({ info } as unknown as Logger, options)(
    { method: 'GET', path: '/api/memories', ...req } as RequestLogRequest,
    { statusCode: 200, on: (_e: 'finish', l: () => void) => (finish = l) },
    handler
  );
  finish();
  return (info.mock.calls[0]?.[0] ?? {}) as LogRecord;
};

describe('setUser on the request log line', () => {
  it('lands on the line the handler is still serving', () => {
    useStackContextManager();
    expect(request(() => setUser('user_1')).user_id).toBe('user_1');
  });

  it('beats req.user.id, and an explicit userId option beats both', () => {
    useStackContextManager();
    expect(request(() => setUser('user_1'), { user: { id: 'req_user' } }).user_id).toBe('user_1');
    expect(request(() => setUser('user_1'), {}, { userId: () => 'explicit' }).user_id).toBe(
      'explicit'
    );
  });

  it('falls back to req.user.id when nobody called it', () => {
    useStackContextManager();
    expect(request(() => {}, { user: { id: 'req_user' } }).user_id).toBe('req_user');
    expect(request(() => {}).user_id).toBeUndefined();
  });

  it('clears with undefined', () => {
    useStackContextManager();
    expect(
      request(() => {
        setUser('user_1');
        setUser(undefined);
      }).user_id
    ).toBeUndefined();
  });

  it('survives the await boundaries of a real handler', async () => {
    useAsyncContextManager();
    const info = vi.fn();
    let finish: () => void = () => {};
    let handled: Promise<void> = Promise.resolve();
    createRequestLog({ info } as unknown as Logger)(
      { method: 'GET', path: '/api/memories' } as RequestLogRequest,
      { statusCode: 200, on: (_e: 'finish', l: () => void) => (finish = l) },
      () => {
        handled = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          setUser('user_1');
          await new Promise((resolve) => setTimeout(resolve, 1));
        })();
      }
    );
    await handled;
    finish();
    expect((info.mock.calls[0][0] as LogRecord).user_id).toBe('user_1');
  });
});

describe('setUser on error events', () => {
  const errorResponse = (): ErrorResponse => ({
    headersSent: false,
    status: () => errorResponse(),
    json: () => undefined,
  });

  it('attaches user_id to an error raised under the request', () => {
    useStackContextManager();
    const error = vi.fn();
    request(() => {
      setUser('user_1');
      errorMiddleware({ error } as unknown as Logger)(
        new Error('kaput'),
        { method: 'GET', path: '/api/memories' },
        errorResponse(),
        () => {}
      );
    });
    expect((error.mock.calls[0][0] as LogRecord).user_id).toBe('user_1');
  });

  it('reaches the Next handler the same way', async () => {
    useAsyncContextManager();
    const error = vi.fn();
    await span('render', async () => {
      setUser('user_1');
      await Promise.resolve();
      onRequestError({ error } as unknown as Logger)(new Error('kaput'), {}, {});
    });
    expect((error.mock.calls[0][0] as LogRecord).user_id).toBe('user_1');
  });
});

describe('setUser on the active span', () => {
  it('sets user.id where the trace can be filtered on it', () => {
    const setAttribute = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttribute } as never);
    setUser('user_1');
    expect(setAttribute).toHaveBeenCalledWith('user.id', 'user_1');
  });

  it('never sets an empty attribute, and is safe with no span at all', () => {
    const setAttribute = vi.fn();
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttribute } as never);
    setUser(undefined);
    expect(setAttribute).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(() => setUser('user_1')).not.toThrow();
  });

  it('carries an id set before the span onto the span itself', async () => {
    useAsyncContextManager();
    const setAttribute = vi.fn();
    const started = { setAttribute, recordException: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: (_n: string, _o: unknown, fn: (s: unknown) => unknown) => fn(started),
    } as never);
    await span('outer', async () => {
      setUser('user_1');
      await span('inner', async () => 'ok');
    });
    expect(setAttribute).toHaveBeenCalledWith('user.id', 'user_1');
  });
});
