import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { errorMiddleware, onRequestError, type ErrorResponse } from '../src/error-emitters.js';
import { redactArgs, errorCodeOf, fingerprintOf } from '../src/error-event.js';

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

function res(headersSent = false): ErrorResponse & { code?: number; body?: unknown } {
  const r = {
    headersSent,
    code: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      r.code = code;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return body;
    },
  };
  return r;
}

describe('errorMiddleware', () => {
  it('emits the standard event and answers the error envelope', () => {
    const out = capture();
    const handler = errorMiddleware(createLogger({ service: 'api', destination: out }));
    const err = Object.assign(new Error('nope'), { status: 404, name: 'NotFoundError' });
    const response = res();
    const next = vi.fn();
    handler(
      err,
      {
        method: 'GET',
        baseUrl: '/api/memories',
        path: '/api/memories/abc',
        route: { path: '/:id' },
        user: { id: 'u1' },
      } as never,
      response,
      next
    );
    const [line] = out.lines();
    expect(line.route).toBe('/api/memories/:id');
    expect(line.method).toBe('GET');
    expect(line.status).toBe(404);
    expect(line.user_id).toBe('u1');
    expect(line.error_code).toBe('NotFoundError');
    expect(line.source).toBe('server');
    expect(line.service).toBe('api');
    expect((line.err as { type: string; stack: string }).stack).toContain('nope');
    expect(response.code).toBe(404);
    expect(response.body).toEqual({ success: false, error: { message: 'nope' } });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes an explicit fingerprint through and falls back to 500 + req.path', () => {
    const out = capture();
    const handler = errorMiddleware(createLogger({ service: 'api', destination: out }));
    const err = Object.assign(new Error('boom'), { fingerprint: 'store-write', code: 'E_STORE' });
    handler(err, { method: 'POST', path: '/api/x' } as never, res(), vi.fn());
    const [line] = out.lines();
    expect(line.fingerprint).toBe('store-write');
    expect(line.error_code).toBe('E_STORE');
    expect(line.status).toBe(500);
    expect(line.route).toBe('/api/x');
  });

  it('delegates to next when headers were already sent', () => {
    const out = capture();
    const handler = errorMiddleware(createLogger({ service: 'api', destination: out }));
    const err = new Error('late');
    const next = vi.fn();
    const response = res(true);
    handler(err, { method: 'GET', path: '/stream' } as never, response, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(response.code).toBeUndefined();
    expect(out.lines()).toHaveLength(1);
  });

  it('accepts a custom user-id accessor and non-Error throwables', () => {
    const out = capture();
    const handler = errorMiddleware(createLogger({ service: 'api', destination: out }), {
      userId: (req) => (req as { auth?: { sub?: string } }).auth?.sub,
    });
    const response = res();
    handler('plain failure', { method: 'GET', auth: { sub: 'u9' } } as never, response, vi.fn());
    const [line] = out.lines();
    expect(line.user_id).toBe('u9');
    expect(line.route).toBeUndefined();
    expect(response.body).toEqual({ success: false, error: { message: 'plain failure' } });
  });
});

describe('onRequestError', () => {
  it('logs the Next server error with the templated route', () => {
    const out = capture();
    const handler = onRequestError(createLogger({ service: 'dashboard', destination: out }));
    handler(
      new Error('render failed'),
      { path: '/memories/1', method: 'GET' },
      {
        routePath: '/memories/[id]',
        routerKind: 'App Router',
        routeType: 'render',
      }
    );
    const [line] = out.lines();
    expect(line.route).toBe('/memories/[id]');
    expect(line.method).toBe('GET');
    expect(line.status).toBe(500);
    expect(line.source).toBe('server');
    expect(line.router_kind).toBe('App Router');
    expect(line.msg).toBe('render failed');
  });

  it('falls back to the request path and keeps a fingerprint', () => {
    const out = capture();
    const handler = onRequestError(createLogger({ service: 'dashboard', destination: out }));
    handler(Object.assign(new Error('x'), { fingerprint: 'fp-1' }), { path: '/a' }, {});
    const [line] = out.lines();
    expect(line.route).toBe('/a');
    expect(line.fingerprint).toBe('fp-1');
  });
});

describe('error-event helpers', () => {
  it('redacts secret-ish keys and truncates long values', () => {
    const args = redactArgs({
      token: 'abc',
      apiKey: 'k',
      PASSWORD: 'p',
      query: 'q'.repeat(250),
      nested: { secretValue: 's', keep: 1 },
      list: ['a'.repeat(250)],
    }) as Record<string, unknown>;
    expect(args.token).toBe('[redacted]');
    expect(args.apiKey).toBe('[redacted]');
    expect(args.PASSWORD).toBe('[redacted]');
    expect(args.query).toHaveLength(203);
    expect((args.nested as Record<string, unknown>).secretValue).toBe('[redacted]');
    expect((args.nested as Record<string, unknown>).keep).toBe(1);
    expect((args.list as string[])[0]).toHaveLength(203);
  });

  it('ignores non-object args and stops at max depth', () => {
    expect(redactArgs('x')).toBeUndefined();
    expect(redactArgs(null)).toBeUndefined();
    expect(redactArgs([1, 2])).toBeUndefined();
    const deep = redactArgs({ a: { b: { c: { d: { e: 1 } } } } }) as Record<string, unknown>;
    expect(JSON.stringify(deep)).toContain('[object]');
  });

  it('reads code/name and fingerprint off throwables', () => {
    expect(errorCodeOf(new TypeError('t'))).toBe('TypeError');
    expect(errorCodeOf('plain')).toBeUndefined();
    expect(fingerprintOf(new Error('e'))).toBeUndefined();
  });
});
