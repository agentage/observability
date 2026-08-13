import { describe, it, expect, vi } from 'vitest';
import { createRequestLog, type RequestLogRequest } from '../src/request-log.js';
import type { Logger } from 'pino';

type LogRecord = Record<string, unknown>;

const run = (
  req: Partial<RequestLogRequest> & LogRecord,
  options?: Parameters<typeof createRequestLog>[1],
  statusCode = 200
): LogRecord => {
  const info = vi.fn();
  let finish: () => void = () => {};
  const res = {
    statusCode,
    on: (_event: 'finish', listener: () => void) => {
      finish = listener;
    },
  };
  const next = vi.fn();
  createRequestLog({ info } as unknown as Logger, options)(
    { method: 'GET', path: '/', ...req } as RequestLogRequest,
    res,
    next
  );
  expect(next).toHaveBeenCalledOnce();
  finish();
  expect(info).toHaveBeenCalledOnce();
  return info.mock.calls[0][0] as LogRecord;
};

describe('createRequestLog', () => {
  it('logs the wide event with the matched route template', () => {
    const record = run(
      {
        method: 'GET',
        path: '/api/memories/abc123def456',
        baseUrl: '/api/memories',
        route: { path: '/:id' },
        user: { id: 'user_1' },
      },
      undefined,
      201
    );
    expect(record).toMatchObject({
      kind: 'http',
      method: 'GET',
      path: '/api/memories/abc123def456',
      route: '/api/memories/:id',
      status: 201,
      user_id: 'user_1',
    });
    expect(typeof record.duration_ms).toBe('number');
    expect(record).not.toHaveProperty('user_type');
  });

  it('falls back to the url-derived route on a 404 (no req.route)', () => {
    const record = run({ method: 'POST', path: '/api/memories/42/notes' }, undefined, 404);
    expect(record.route).toBe('/api/memories/:id/notes');
    expect(record.status).toBe(404);
    expect(record.user_id).toBeUndefined();
  });

  it('falls back to the url-derived route for a RegExp-mounted route', () => {
    const record = run({
      path: '/api/auth/get-session',
      baseUrl: '',
      route: { path: '/^\\/api\\/auth\\//' },
    });
    expect(record.route).toBe('/api/auth/get-session');
  });

  it('trims the trailing slash of a router index route', () => {
    const record = run({ path: '/api/memories/', baseUrl: '/api/memories', route: { path: '/' } });
    expect(record.route).toBe('/api/memories');
  });

  it('trims the trailing slash on the fallback path too', () => {
    const record = run({ path: '/api/memories/' });
    expect(record.route).toBe('/api/memories');
  });

  it('logs the full path for a request rejected inside a mounted router', () => {
    const info = vi.fn();
    let finish: () => void = () => {};
    const req = {
      method: 'GET',
      path: '/api/admin/whoami',
      originalUrl: '/api/admin/whoami',
      baseUrl: '',
    } as RequestLogRequest;
    createRequestLog({ info } as unknown as Logger)(
      req,
      {
        statusCode: 401,
        on: (_e: 'finish', l: () => void) => {
          finish = l;
        },
      },
      () => {}
    );
    // Express rewrites both to be router-relative once the mounted router runs.
    Object.assign(req, { path: '/whoami', baseUrl: '/api/admin' });
    finish();
    expect(info.mock.calls[0][0]).toMatchObject({
      path: '/api/admin/whoami',
      route: '/api/admin/whoami',
      status: 401,
    });
  });

  it('strips the query string from originalUrl', () => {
    const record = run({
      method: 'GET',
      path: '/api/memories',
      originalUrl: '/api/memories?limit=10&q=a',
    });
    expect(record.path).toBe('/api/memories');
    expect(record.route).toBe('/api/memories');
  });

  it('prefers originalUrl over path for the matched-route regex fallback', () => {
    const record = run({
      path: '/get-session',
      originalUrl: '/api/auth/get-session',
      baseUrl: '/api/auth',
      route: { path: '/^\\/get-session$/' },
    });
    expect(record.path).toBe('/api/auth/get-session');
    expect(record.route).toBe('/api/auth/get-session');
  });

  it('adds user_type from the injected classifier and honors a custom message', () => {
    const info = vi.fn();
    let finish: () => void = () => {};
    const classify = vi.fn(() => 'bot');
    createRequestLog({ info } as unknown as Logger, {
      classify,
      userId: () => 'from-opt',
      message: 'http',
    })(
      { method: 'GET', path: '/health' } as RequestLogRequest,
      {
        statusCode: 200,
        on: (_e: 'finish', l: () => void) => {
          finish = l;
        },
      },
      () => {}
    );
    finish();
    expect(classify).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toMatchObject({ user_type: 'bot', user_id: 'from-opt' });
    expect(info.mock.calls[0][1]).toBe('http');
  });
});
