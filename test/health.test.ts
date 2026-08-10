import { describe, it, expect } from 'vitest';
import {
  createHealthHandler,
  healthEnvelope,
  healthResponse,
  httpStatusFor,
  resolveHealth,
  resolveServiceName,
  runCheckOutcomes,
  runChecks,
  serverTimingHeader,
  staticHealthJson,
  statusFromChecks,
  type CheckState,
  type HealthResponseLike,
} from '../src/health.js';

const built = {
  OTEL_SERVICE_NAME: 'memory-mcp',
  COMMIT_SHA: '21150d69f1073f06de2b4d3fb1d199defa2a4b07',
  BUILD_TIME: '2026-08-09T10:08:07Z',
} satisfies NodeJS.ProcessEnv;

describe('resolveServiceName', () => {
  it('prefers the explicit name, then OTEL_SERVICE_NAME', () => {
    expect(resolveServiceName('sync', built)).toBe('sync');
    expect(resolveServiceName(undefined, built)).toBe('memory-mcp');
  });

  it('falls back to a loud "unknown" the contract gate can fail on', () => {
    expect(resolveServiceName('   ', { OTEL_SERVICE_NAME: '  ' })).toBe('unknown');
  });
});

describe('healthEnvelope', () => {
  it('reports build provenance from the image env', () => {
    const { data } = healthEnvelope(undefined, { env: built });
    expect(data).toMatchObject({
      status: 'ok',
      service: 'memory-mcp',
      version: built.COMMIT_SHA,
      commit: '21150d6',
      buildTime: '2026-08-09T10:08:07Z',
    });
  });

  it('reads a blank BUILD_TIME as null - `??` shipped "" to production', () => {
    expect(healthEnvelope('landing', { env: { BUILD_TIME: '' } }).data.buildTime).toBeNull();
    expect(healthEnvelope('landing', { env: { BUILD_TIME: '   ' } }).data.buildTime).toBeNull();
  });

  it('marks an unbuilt local process rather than pretending to a version', () => {
    const { data } = healthEnvelope('sync', { env: {} });
    expect(data.version).toBe('0.0.0-dev');
    expect(data.commit).toBe('dev');
  });

  it('derives uptime from the same instant it reports as startedAt', () => {
    const startedAt = new Date(Date.now() - 90_000);
    const { data } = healthEnvelope('sync', { env: built, startedAt });
    expect(data.startedAt).toBe(startedAt.toISOString());
    expect(data.uptimeSeconds).toBe(90);
  });

  it('omits checks and facts entirely when there are none', () => {
    const { data } = healthEnvelope('sync', { env: built });
    expect(data).not.toHaveProperty('checks');
    expect(data).not.toHaveProperty('facts');
  });

  it('fails success on an outage so a caller can act on the flag alone', () => {
    const down = healthEnvelope('auth', { env: built, checks: { db: 'down' } });
    expect(down.success).toBe(false);
    expect(down.data.status).toBe('unavailable');
    expect(healthEnvelope('auth', { env: built, checks: { db: 'degraded' } }).success).toBe(true);
  });

  it('lets an explicit status and success override the derivation', () => {
    const env = healthEnvelope('auth', { env: built, status: 'degraded', success: false });
    expect(env.data.status).toBe('degraded');
    expect(env.success).toBe(false);
  });
});

describe('statusFromChecks', () => {
  const cases: [Record<string, CheckState> | undefined, string][] = [
    [undefined, 'ok'],
    [{}, 'ok'],
    [{ db: 'ok', store: 'skipped' }, 'ok'],
    [{ db: 'ok', store: 'degraded' }, 'degraded'],
    [{ db: 'down', store: 'degraded' }, 'unavailable'],
  ];

  it.each(cases)('%o -> %s', (checks, expected) => {
    expect(statusFromChecks(checks)).toBe(expected);
  });
});

describe('httpStatusFor', () => {
  it('keeps a degraded service at 200 and 503s only a real outage', () => {
    expect(httpStatusFor('ok')).toBe(200);
    expect(httpStatusFor('degraded')).toBe(200);
    expect(httpStatusFor('unavailable')).toBe(503);
  });
});

describe('runChecks', () => {
  it('maps booleans to states and keeps every check keyed by name', async () => {
    expect(
      await runChecks([
        { name: 'db', run: () => true },
        { name: 'store', run: () => false },
        { name: 'index', run: () => 'skipped' },
      ])
    ).toEqual({ db: 'ok', store: 'down', index: 'skipped' });
  });

  it('reads a throwing or rejecting check as down, never propagating', async () => {
    expect(
      await runChecks([
        {
          name: 'sync',
          run: () => {
            throw new Error('boom');
          },
        },
        { name: 'async', run: () => Promise.reject(new Error('boom')) },
      ])
    ).toEqual({ sync: 'down', async: 'down' });
  });

  it('times a hung dependency out instead of hanging the probe', async () => {
    const hang = new Promise<boolean>(() => {});
    expect(await runChecks([{ name: 'mongo', run: () => hang, timeoutMs: 10 }])).toEqual({
      mongo: 'down',
    });
  });

  it('degrades rather than downs an optional dependency', async () => {
    expect(
      await runChecks([
        { name: 'cache', optional: true, run: () => Promise.reject(new Error('boom')) },
        {
          name: 'search',
          optional: true,
          run: () => new Promise<boolean>(() => {}),
          timeoutMs: 10,
        },
      ])
    ).toEqual({ cache: 'degraded', search: 'degraded' });
  });

  it('runs checks in parallel, so the slowest one sets the cost', async () => {
    const slow = (ms: number) => () => new Promise<boolean>((r) => setTimeout(() => r(true), ms));
    const started = Date.now();
    await runChecks([
      { name: 'a', run: slow(60) },
      { name: 'b', run: slow(60) },
      { name: 'c', run: slow(60) },
    ]);
    expect(Date.now() - started).toBeLessThan(150);
  });
});

describe('resolveHealth', () => {
  it('folds checks and facts into one envelope with its HTTP status', async () => {
    const { envelope, httpStatus } = await resolveHealth({
      service: 'catalog-backend',
      env: built,
      checks: [{ name: 'db', run: () => true }],
      facts: () => ({ servers: 15243 }),
    });
    expect(httpStatus).toBe(200);
    expect(envelope.data.checks).toEqual({ db: 'ok' });
    expect(envelope.data.facts).toEqual({ servers: 15243 });
  });

  it('503s an outage but still answers with data explaining it', async () => {
    const { envelope, httpStatus } = await resolveHealth({
      service: 'catalog-backend',
      env: built,
      checks: [{ name: 'db', run: () => false }],
    });
    expect(httpStatus).toBe(503);
    expect(envelope.data.status).toBe('unavailable');
    expect(envelope.data.checks).toEqual({ db: 'down' });
  });

  it('drops throwing facts instead of reddening a healthy service', async () => {
    const { envelope, httpStatus } = await resolveHealth({
      service: 'memory-backend',
      env: built,
      facts: () => {
        throw new Error('du failed');
      },
    });
    expect(httpStatus).toBe(200);
    expect(envelope.data).not.toHaveProperty('facts');
  });
});

// Express is not a dependency here, so its Response/RequestHandler signatures are
// restated: the handler has to drop into `app.get('/health', handler)` unchanged in
// every consuming repo, and only the type checker can prove that from this package.
interface ExpressResponseShape {
  status(code: number): this;
  setHeader(name: string, value: number | string | ReadonlyArray<string>): this;
  json(body: unknown): this;
}
type ExpressHandlerShape = (
  req: { path: string },
  res: ExpressResponseShape,
  next: (err?: unknown) => void
) => void;

describe('createHealthHandler', () => {
  it('satisfies the express RequestHandler shape without an express dependency', () => {
    const handler: ExpressHandlerShape = createHealthHandler({ service: 'sync' });
    expect(typeof handler).toBe('function');
  });

  const spyResponse = () => {
    const calls = { code: 0, headers: {} as Record<string, string>, body: undefined as unknown };
    const res: HealthResponseLike = {
      status: (code) => (calls.code = code),
      setHeader: (name, value) => (calls.headers[name] = value),
      json: (body) => (calls.body = body),
    };
    return { res, calls };
  };

  it('answers 200 and forbids caching a liveness answer', async () => {
    const { res, calls } = spyResponse();
    await createHealthHandler({ service: 'sync', env: built })({}, res);
    expect(calls.code).toBe(200);
    expect(calls.headers['Cache-Control']).toBe('no-store');
    expect(calls.body).toMatchObject({ success: true, data: { service: 'sync' } });
  });

  it('answers 503 with the failing check named', async () => {
    const { res, calls } = spyResponse();
    await createHealthHandler({
      service: 'auth',
      env: built,
      checks: [{ name: 'db', run: () => false }],
    })({}, res);
    expect(calls.code).toBe(503);
    expect(calls.body).toMatchObject({ success: false, data: { checks: { db: 'down' } } });
  });
});

describe('healthResponse', () => {
  it('returns an uncacheable JSON Response for a Next route handler', async () => {
    const res = await healthResponse({ service: 'dashboard', env: built });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toMatchObject({ data: { service: 'dashboard', commit: '21150d6' } });
  });

  it('carries the 503 through to the response status', async () => {
    const res = await healthResponse({
      service: 'dashboard',
      env: built,
      checks: [{ name: 'store', run: () => false }],
    });
    expect(res.status).toBe(503);
  });
});

describe('staticHealthJson', () => {
  it('omits the fields an image with no process cannot honestly report', () => {
    const data = JSON.parse(staticHealthJson({ service: 'api-gateway', env: built })) as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(data.success).toBe(true);
    expect(data.data).toEqual({
      status: 'ok',
      service: 'api-gateway',
      version: built.COMMIT_SHA,
      commit: '21150d6',
      buildTime: '2026-08-09T10:08:07Z',
    });
    expect(data.data).not.toHaveProperty('uptimeSeconds');
    expect(data.data).not.toHaveProperty('startedAt');
  });

  it('emits a single line, so a Dockerfile can redirect it straight to a file', () => {
    expect(staticHealthJson({ service: 'agentage-ds', env: built })).not.toContain('\n');
  });
});

describe('instance', () => {
  it('is stable within a process, so a changing value means a different replica', () => {
    const a = healthEnvelope('sync', { env: built }).data.instance;
    const b = healthEnvelope('sync', { env: built }).data.instance;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-z]{8}$/);
  });

  it('is not the hostname - /health is public and must not leak internal topology', () => {
    const { instance } = healthEnvelope('sync', { env: built }).data;
    expect(instance).not.toContain('.');
    expect(instance).not.toBe(process.env.HOSTNAME);
  });
});

describe('checkedAt', () => {
  it('advances between calls - a frozen value is how a probe detects a cache', async () => {
    const first = healthEnvelope('sync', { env: built }).data.checkedAt;
    await new Promise((r) => setTimeout(r, 5));
    const second = healthEnvelope('sync', { env: built }).data.checkedAt;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
  });

  it('is the instant uptime is measured against, so the two can never disagree', () => {
    const startedAt = new Date(Date.now() - 90_000);
    const checkedAt = new Date(startedAt.getTime() + 120_000);
    const { data } = healthEnvelope('sync', { env: built, startedAt, checkedAt });
    expect(data.checkedAt).toBe(checkedAt.toISOString());
    expect(data.uptimeSeconds).toBe(120);
  });
});

describe('startedAt', () => {
  it('is process start, not module load - a lazy Next route must not reset uptime', () => {
    const { data } = healthEnvelope('sync', { env: built });
    const drift = Math.abs(Date.now() - process.uptime() * 1000 - Date.parse(data.startedAt));
    expect(drift).toBeLessThan(1000);
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(Math.floor(process.uptime()) - 1);
  });
});

describe('timings', () => {
  it('reports what each check cost, so a memoized one is visibly not a real query', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      checks: [
        { name: 'cached', run: () => true },
        { name: 'real', run: () => new Promise<boolean>((r) => setTimeout(() => r(true), 40)) },
      ],
    });
    const timings = envelope.data.timings!;
    expect(timings.cached).toBeLessThan(10);
    expect(timings.real).toBeGreaterThanOrEqual(35);
  });

  it('times the facts producer under its own key', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      facts: () => new Promise((r) => setTimeout(() => r({ servers: 1 }), 30)),
    });
    expect(envelope.data.timings!.facts).toBeGreaterThanOrEqual(25);
  });

  it('reports a total that covers the slowest check, since checks run in parallel', async () => {
    const slow = (ms: number) => () => new Promise<boolean>((r) => setTimeout(() => r(true), ms));
    const { envelope } = await resolveHealth({
      env: built,
      checks: [
        { name: 'a', run: slow(40) },
        { name: 'b', run: slow(40) },
      ],
    });
    expect(envelope.data.durationMs).toBeGreaterThanOrEqual(35);
    expect(envelope.data.durationMs).toBeLessThan(120);
  });

  it('omits both maps on a service with no checks and no facts', async () => {
    const { envelope } = await resolveHealth({ service: 'landing', env: built });
    expect(envelope.data).not.toHaveProperty('timings');
    expect(envelope.data).not.toHaveProperty('reasons');
  });
});

describe('reasons', () => {
  it('separates a timeout from an instant refusal - both read "down" alone', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      checks: [
        { name: 'slow', run: () => new Promise<boolean>(() => {}), timeoutMs: 20 },
        { name: 'refused', run: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.4:5432')) },
      ],
    });
    expect(envelope.data.reasons).toEqual({
      slow: 'timed out after 20ms',
      refused: 'ECONNREFUSED 10.0.0.4:5432',
    });
  });

  it('says nothing about a check that simply reported false', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      checks: [{ name: 'db', run: () => false }],
    });
    expect(envelope.data.checks).toEqual({ db: 'down' });
    expect(envelope.data).not.toHaveProperty('reasons');
  });

  it('flattens and bounds a driver message rather than pasting a stack onto a public page', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      checks: [{ name: 'db', run: () => Promise.reject(new Error(`a\nb${'x'.repeat(500)}`)) }],
    });
    const reason = envelope.data.reasons!.db;
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(203);
    expect(reason.endsWith('...')).toBe(true);
  });
});

describe('facts timeout', () => {
  it('bounds a hanging producer instead of outliving the container HEALTHCHECK', async () => {
    const started = Date.now();
    const { envelope, httpStatus } = await resolveHealth({
      env: built,
      facts: () => new Promise<Record<string, unknown>>(() => {}),
      factsTimeoutMs: 30,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(httpStatus).toBe(200);
    expect(envelope.data).not.toHaveProperty('facts');
    expect(envelope.data.reasons!.facts).toBe('timed out after 30ms');
  });

  it('keeps a hung fact from downing a service whose checks all passed', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      checks: [{ name: 'db', run: () => true }],
      facts: () => new Promise<Record<string, unknown>>(() => {}),
      factsTimeoutMs: 20,
    });
    expect(envelope.data.status).toBe('ok');
    expect(envelope.success).toBe(true);
  });
});

describe('runCheckOutcomes', () => {
  it('carries state, cost and reason per check', async () => {
    const outcomes = await runCheckOutcomes([
      { name: 'db', run: () => true },
      { name: 'cache', optional: true, run: () => new Promise<boolean>(() => {}), timeoutMs: 15 },
    ]);
    expect(outcomes.db.state).toBe('ok');
    expect(outcomes.db.reason).toBeUndefined();
    expect(outcomes.cache).toMatchObject({ state: 'degraded', reason: 'timed out after 15ms' });
    expect(outcomes.cache.durationMs).toBeGreaterThanOrEqual(10);
  });
});

describe('serverTimingHeader', () => {
  it('mirrors the body timings into the standard header', async () => {
    const { envelope } = await resolveHealth({
      env: built,
      checks: [{ name: 'db', run: () => true }],
      facts: () => ({ servers: 3 }),
    });
    const header = serverTimingHeader(envelope.data);
    expect(header).toMatch(/^health;dur=[\d.]+/);
    expect(header).toContain('db;dur=');
    expect(header).toContain('facts;dur=');
  });

  it('sanitises a check name that is not a valid header token', () => {
    const header = serverTimingHeader({
      ...healthEnvelope('sync', { env: built }).data,
      timings: { 'redis cache': 4 },
    });
    expect(header).toContain('redis_cache;dur=4');
  });

  it('is set on both transports', async () => {
    const res = await healthResponse({
      service: 'dashboard',
      env: built,
      checks: [{ name: 'store', run: () => true }],
    });
    expect(res.headers.get('server-timing')).toContain('store;dur=');
  });
});

describe('staticHealthJson timing fields', () => {
  it('omits every field a build-time payload cannot honestly report', () => {
    const { data } = JSON.parse(staticHealthJson({ service: 'web', env: built })) as {
      data: Record<string, unknown>;
    };
    for (const field of ['instance', 'checkedAt', 'durationMs', 'timings', 'reasons']) {
      expect(data).not.toHaveProperty(field);
    }
  });
});
