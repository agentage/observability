/**
 * The one `/health` envelope every agentage service returns, so a single probe
 * (Traefik, the admin Services page, `wget --spider`) reads the same shape
 * everywhere. Contract: vault `specs/health-endpoints`.
 *
 * `service` defaults to OTEL_SERVICE_NAME, which is what makes the health name
 * and the telemetry `service.name` equal by construction instead of by
 * discipline - the estate had them agreeing in 1 of 10 services when they were
 * hand-typed per repo.
 *
 * Build provenance (`version`/`commit`/`buildTime`) is baked per image via the
 * Dockerfile `ARG COMMIT_SHA` / `ARG BUILD_TIME` -> ENV. Pure logic plus the
 * global `process`: no imports, safe in an isomorphic barrel, only ever called
 * server-side.
 */

export type CheckState = 'ok' | 'degraded' | 'down' | 'skipped';
export type HealthStatus = 'ok' | 'degraded' | 'unavailable';

export interface HealthData {
  status: HealthStatus;
  service: string;
  version: string; // full COMMIT_SHA, or '0.0.0-dev' when unset (local)
  commit: string; // 7-char short SHA, or 'dev'
  buildTime: string | null; // ISO from BUILD_TIME, null when unset OR blank
  startedAt: string; // ISO process start == last deploy (a deploy restarts the container)
  uptimeSeconds: number;
  checks?: Record<string, CheckState>;
  facts?: Record<string, unknown>;
}

/** No process behind it (nginx, a static bundle), so there is no uptime to report. */
export type StaticHealthData = Omit<HealthData, 'startedAt' | 'uptimeSeconds'>;

export interface HealthEnvelope<T = HealthData> {
  success: boolean;
  data: T;
}

const STARTED_AT = new Date();

const clean = (value: string | undefined): string => (value ?? '').trim();

/** 'unknown' is deliberately loud: the estate contract gate fails on it. */
export function resolveServiceName(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return clean(explicit) || clean(env.OTEL_SERVICE_NAME) || 'unknown';
}

// `||`, never `??`: the deployed value is an empty string often enough that `??`
// shipped `buildTime: ""` to production on the landing service.
const provenance = (env: NodeJS.ProcessEnv) => {
  const sha = clean(env.COMMIT_SHA);
  return {
    version: sha || '0.0.0-dev',
    commit: sha.slice(0, 7) || 'dev',
    buildTime: clean(env.BUILD_TIME) || null,
  };
};

/**
 * Worst check wins. A dependency the service can survive without must report
 * `degraded` rather than `down` - `down` means the service cannot do its job.
 */
export function statusFromChecks(checks?: Record<string, CheckState>): HealthStatus {
  const states = Object.values(checks ?? {});
  if (states.includes('down')) return 'unavailable';
  if (states.includes('degraded')) return 'degraded';
  return 'ok';
}

export const httpStatusFor = (status: HealthStatus): number =>
  status === 'unavailable' ? 503 : 200;

export interface HealthOptions {
  /** Overrides the status derived from `checks`. */
  status?: HealthStatus;
  /** Defaults to `status !== 'unavailable'`. */
  success?: boolean;
  checks?: Record<string, CheckState>;
  /** Counts and sizes only, never state, so a probe never has to type-sniff. */
  facts?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  startedAt?: Date;
}

export function healthEnvelope(service?: string, options: HealthOptions = {}): HealthEnvelope {
  const env = options.env ?? process.env;
  const startedAt = options.startedAt ?? STARTED_AT;
  const status = options.status ?? statusFromChecks(options.checks);
  return {
    success: options.success ?? status !== 'unavailable',
    data: {
      status,
      service: resolveServiceName(service, env),
      ...provenance(env),
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      ...(options.checks ? { checks: options.checks } : {}),
      ...(options.facts ? { facts: options.facts } : {}),
    },
  };
}

export interface HealthCheck {
  name: string;
  /** `true`/`false` is shorthand for `'ok'`/`'down'`. */
  run: () => Promise<CheckState | boolean> | CheckState | boolean;
  timeoutMs?: number;
  /** A failing optional dependency degrades the service instead of downing it. */
  optional?: boolean;
}

// Kept well under the container HEALTHCHECK --timeout so a hung dependency
// reports as down rather than hanging the probe itself.
const DEFAULT_CHECK_TIMEOUT_MS = 1000;

const asState = (value: CheckState | boolean): CheckState =>
  typeof value === 'boolean' ? (value ? 'ok' : 'down') : value;

const failState = (check: HealthCheck): CheckState => (check.optional ? 'degraded' : 'down');

async function runCheck(check: HealthCheck, defaultTimeoutMs: number): Promise<CheckState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<CheckState>((resolve) => {
    timer = setTimeout(() => resolve(failState(check)), check.timeoutMs ?? defaultTimeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(check.run()).then(asState), expiry]);
  } catch {
    return failState(check);
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(
  checks: HealthCheck[] = [],
  defaultTimeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<Record<string, CheckState>> {
  const states = await Promise.all(checks.map((check) => runCheck(check, defaultTimeoutMs)));
  return Object.fromEntries(checks.map((check, i) => [check.name, states[i]]));
}

export interface HealthSourceOptions {
  service?: string;
  checks?: HealthCheck[];
  facts?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  checkTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// Facts are decoration; a throwing producer must never turn a healthy service red.
async function safeFacts(
  produce: NonNullable<HealthSourceOptions['facts']>
): Promise<Record<string, unknown> | undefined> {
  try {
    return await produce();
  } catch {
    return undefined;
  }
}

export async function resolveHealth(
  options: HealthSourceOptions = {}
): Promise<{ envelope: HealthEnvelope; httpStatus: number }> {
  const [checks, facts] = await Promise.all([
    options.checks?.length ? runChecks(options.checks, options.checkTimeoutMs) : undefined,
    options.facts ? safeFacts(options.facts) : undefined,
  ]);
  const envelope = healthEnvelope(options.service, { checks, facts, env: options.env });
  return { envelope, httpStatus: httpStatusFor(envelope.data.status) };
}

/** Structural: keeps express out of this package's dependencies. */
export interface HealthResponseLike {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

/** Express handler. Mount on `/health`, and on `/api/health` where the edge routes only `/api`. */
export function createHealthHandler(options: HealthSourceOptions = {}) {
  return async (_req: unknown, res: HealthResponseLike): Promise<void> => {
    const { envelope, httpStatus } = await resolveHealth(options);
    res.setHeader('Cache-Control', 'no-store');
    res.status(httpStatus);
    res.json(envelope);
  };
}

/** Next App Router route handler body. Pair with `export const dynamic = 'force-dynamic'`. */
export async function healthResponse(options: HealthSourceOptions = {}): Promise<Response> {
  const { envelope, httpStatus } = await resolveHealth(options);
  return new Response(JSON.stringify(envelope), {
    status: httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export interface StaticHealthOptions {
  service?: string;
  checks?: Record<string, CheckState>;
  facts?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

/** Build-time payload for images with no Node process (nginx, static bundles). */
export function staticHealthJson(options: StaticHealthOptions = {}): string {
  const env = options.env ?? process.env;
  const status = statusFromChecks(options.checks);
  const data: StaticHealthData = {
    status,
    service: resolveServiceName(options.service, env),
    ...provenance(env),
    ...(options.checks ? { checks: options.checks } : {}),
    ...(options.facts ? { facts: options.facts } : {}),
  };
  return JSON.stringify({
    success: status !== 'unavailable',
    data,
  } satisfies HealthEnvelope<StaticHealthData>);
}
