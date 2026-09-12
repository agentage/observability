import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import express4 from 'express4';
import { log } from '../src/log.js';
import { autoWire, patchExpressModule } from '../src/internal/patch/express.js';
import { errorMiddleware } from '../src/internal/patch/error-emitters.js';

/**
 * The listen patch itself, applied to both majors: after this, `app.listen()`
 * auto-wires exactly as it does behind the module hook in a booted service.
 */
patchExpressModule(express as unknown as { application?: Record<string, unknown> });
patchExpressModule(express4 as unknown as { application?: Record<string, unknown> });

const lines: Record<string, unknown>[] = [];

const linesOf = (kind: string): Record<string, unknown>[] =>
  lines.filter((line) => line.kind === kind);

beforeEach(() => {
  lines.length = 0;
  vi.stubEnv('OTEL_SERVICE_NAME', 'patch-test');
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Not one of ours; the stream carries other writers too.
      }
    }
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface Booted {
  url: string;
  close: () => Promise<void>;
}

const boot = async (app: Express): Promise<Booted> => {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

const withApp = async (
  factory: typeof express,
  build: (app: Express) => void,
  run: (booted: Booted) => Promise<void>
): Promise<void> => {
  const app = factory();
  build(app);
  const booted = await boot(app);
  try {
    await run(booted);
  } finally {
    await booted.close();
  }
};

const majors: [string, typeof express, boolean][] = [
  ['express 5', express, true],
  ['express 4', express4, false],
];

describe.each(majors)('auto-wiring on %s', (_name, factory, forwardsAsyncThrows) => {
  // Express 4 does not forward a rejected handler promise; the service calls next().
  const boom = (app: Express): void => {
    if (forwardsAsyncThrows) {
      app.get('/boom', async () => {
        await Promise.resolve();
        throw new Error('kaboom');
      });
      return;
    }
    app.get('/boom', (_req, _res, next) => {
      void Promise.resolve().then(() => next(new Error('kaboom')));
    });
  };

  it('logs a request the service never routed, from index 0', async () => {
    await withApp(
      factory,
      (app) => {
        // Registered BEFORE the wiring and answering without calling next: only a
        // middleware mounted ahead of it can log this request.
        app.use('/teapot', (_req, res) => {
          res.status(418).end();
        });
      },
      async ({ url }) => {
        expect((await fetch(`${url}/teapot`)).status).toBe(418);
        expect((await fetch(`${url}/nope`)).status).toBe(404);
        const http = linesOf('http');
        expect(http).toHaveLength(2);
        expect(http[0]).toMatchObject({ method: 'GET', path: '/teapot', status: 418 });
        expect(http[1]).toMatchObject({ route: '(unmatched)', status: 404 });
      }
    );
  });

  it('answers the error envelope and emits one ErrorEvent', async () => {
    await withApp(factory, boom, async ({ url }) => {
      const response = await fetch(`${url}/boom`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: 'Error', message: 'kaboom' },
        traceId: '',
      });
      const errors = lines.filter((line) => line.source === 'server');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ route: '/boom', method: 'GET', status: 500 });
    });
  });

  it('mounts liveness on /health and /api/health', async () => {
    await withApp(
      factory,
      () => {},
      async ({ url }) => {
        for (const path of ['/health', '/api/health']) {
          const response = await fetch(`${url}${path}`);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            success: true,
            data: { status: 'ok', service: 'patch-test' },
          });
        }
      }
    );
  });

  it('leaves a health route the service registered itself alone', async () => {
    await withApp(
      factory,
      (app) => {
        app.get('/health', (_req, res) => {
          res.json({ mine: true });
        });
      },
      async ({ url }) => {
        expect(await (await fetch(`${url}/health`)).json()).toEqual({ mine: true });
        // The one it did not claim is still auto-mounted.
        expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ success: true });
      }
    );
  });

  it('leaves a health route mounted behind a router alone', async () => {
    await withApp(
      factory,
      (app) => {
        const router = factory.Router();
        router.get('/health', (_req, res) => {
          res.json({ mine: 'router' });
        });
        app.use('/api', router);
      },
      async ({ url }) => {
        expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ mine: 'router' });
      }
    );
  });

  it('mounts the collector only when OTEL_CLIENT_ERROR_ORIGINS is set', async () => {
    await withApp(
      factory,
      () => {},
      async ({ url }) => {
        expect((await fetch(`${url}/api/client-errors`, { method: 'POST' })).status).toBe(404);
      }
    );

    vi.stubEnv('OTEL_CLIENT_ERROR_ORIGINS', 'https://app.test');
    await withApp(
      factory,
      () => {},
      async ({ url }) => {
        const post = (origin: string): Promise<Response> =>
          fetch(`${url}/api/client-errors`, {
            method: 'POST',
            headers: { origin, 'content-type': 'text/plain' },
            body: JSON.stringify({
              events: [{ err: { message: 'client boom', type: 'TypeError' }, service: 'web' }],
            }),
          });
        expect((await post('https://evil.test')).status).toBe(403);
        expect((await post('https://app.test')).status).toBe(204);
        const client = lines.filter((line) => line.source === 'client');
        expect(client).toHaveLength(1);
        expect(client[0]).toMatchObject({ service: 'web', error_code: 'TypeError' });
      }
    );
  });

  it('honours every escape hatch', async () => {
    vi.stubEnv('OBS_REQUEST_LOG', 'off');
    vi.stubEnv('OBS_AUTO_HEALTH', 'off');
    vi.stubEnv('OBS_ERROR_MW', 'off');
    await withApp(factory, boom, async ({ url }) => {
      expect((await fetch(`${url}/health`)).status).toBe(404);
      expect((await fetch(`${url}/boom`)).status).toBe(500);
      expect(linesOf('http')).toHaveLength(0);
      expect(lines.filter((line) => line.source === 'server')).toHaveLength(0);
    });
  });

  it('wires once per app, whatever calls it twice', async () => {
    await withApp(
      factory,
      (app) => {
        autoWire(app as never);
        autoWire(app as never);
      },
      async ({ url }) => {
        await fetch(`${url}/health`);
        expect(linesOf('http')).toHaveLength(0); // a probe path logs nothing
        await fetch(`${url}/nope`);
        expect(linesOf('http')).toHaveLength(1);
      }
    );
  });

  it('does not append a second error handler over the app own one', async () => {
    await withApp(
      factory,
      (app) => {
        boom(app);
        app.use(errorMiddleware(log));
      },
      async ({ url }) => {
        await fetch(`${url}/boom`);
        expect(lines.filter((line) => line.source === 'server')).toHaveLength(1);
      }
    );
  });
});
