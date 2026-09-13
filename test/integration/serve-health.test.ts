import { describe, it, expect } from 'vitest';
import { serveHealth, type HealthServer } from '../../src/index.js';

const withServer = async (
  run: (base: string) => Promise<void>,
  ...args: Parameters<typeof serveHealth>
): Promise<void> => {
  const server: HealthServer = serveHealth(...args);
  const port = await server.listening;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
};

describe('serveHealth', () => {
  it('answers the estate envelope on both probe paths', async () => {
    await withServer(
      async (base) => {
        for (const path of ['/health', '/api/health', '/health?probe=1', '/health/']) {
          const res = await fetch(`${base}${path}`);
          expect(res.status, path).toBe(200);
          expect(res.headers.get('content-type')).toContain('application/json');
          expect(res.headers.get('cache-control')).toBe('no-store');
          expect(res.headers.get('server-timing')).toContain('health;dur=');
          const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
          expect(body.success).toBe(true);
          expect(body.data).toMatchObject({ status: 'ok', service: 'crawler-test' });
        }
      },
      0,
      undefined,
      { service: 'crawler-test' }
    );
  });

  it('reports checks, timings and reasons, and 503s when a required one is down', async () => {
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/health`);
        expect(res.status).toBe(503);
        const { data } = (await res.json()) as {
          data: {
            status: string;
            checks: Record<string, string>;
            reasons: Record<string, string>;
            facts: Record<string, unknown>;
          };
        };
        expect(data.status).toBe('unavailable');
        expect(data.checks).toEqual({ db: 'down', cache: 'degraded' });
        expect(data.reasons.db).toContain('no route to host');
        expect(data.facts).toEqual({ servers: 12 });
      },
      0,
      {
        db: () => {
          throw new Error('no route to host');
        },
        cache: {
          run: () => {
            throw new Error('connection refused');
          },
          optional: true,
        },
      },
      { service: 'crawler-test', facts: () => ({ servers: 12 }) }
    );
  });

  it('404s an unknown path and a write method', async () => {
    await withServer(
      async (base) => {
        const missing = await fetch(`${base}/metrics`);
        expect(missing.status).toBe(404);
        expect(missing.headers.get('content-type')).toContain('application/json');
        expect(await missing.json()).toEqual({ success: false, error: { code: 'NotFound' } });
        expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
      },
      0,
      undefined,
      { service: 'crawler-test' }
    );
  });

  it('answers HEAD with the status and headers but no body', async () => {
    await withServer(
      async (base) => {
        const res = await fetch(`${base}/health`, { method: 'HEAD' });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.text()).toBe('');
      },
      0,
      undefined,
      { service: 'crawler-test' }
    );
  });

  it('surfaces a bind failure instead of crashing the worker', async () => {
    const first = serveHealth(0, undefined, { service: 'crawler-test' });
    const port = await first.listening;
    const second = serveHealth(port, undefined, { service: 'crawler-test' });
    await expect(second.listening).rejects.toThrow(/EADDRINUSE/);
    await first.close();
    await second.close();
  });

  it('honours a custom path list', async () => {
    await withServer(
      async (base) => {
        expect((await fetch(`${base}/hc`)).status).toBe(200);
        expect((await fetch(`${base}/health`)).status).toBe(404);
      },
      0,
      undefined,
      { service: 'crawler-test', paths: ['/hc'] }
    );
  });
});
