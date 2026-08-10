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
 * globals `process`/`performance`/`crypto`: no imports, safe in an isomorphic
 * barrel, only ever called server-side.
 */

export type CheckState = 'ok' | 'degraded' | 'down' | 'skipped';
export type HealthStatus = 'ok' | 'degraded' | 'unavailable';

export interface HealthData {
  status: HealthStatus;
  service: string;
  /** Random per process. Distinguishes "a cached response" from "a different replica". */
  instance: string;
  version: string; // full COMMIT_SHA, or '0.0.0-dev' when unset (local)
  commit: string; // 7-char short SHA, or 'dev'
  buildTime: string | null; // ISO from BUILD_TIME, null when unset OR blank
  startedAt: string; // ISO process start == last deploy (a deploy restarts the container)
  uptimeSeconds: number;
  /** When THIS payload was computed. Frozen across two probes means something cached it. */
  checkedAt: string;
  /** Total server-side cost of producing the payload, so a probe can subtract the network. */
  durationMs: number;
  checks?: Record<string, CheckState>;
  /** Per-check wall time, plus `facts`. A check at ~0 is memoized, not measured. */
  timings?: Record<string, number>;
  /** Only for checks that are not ok: why. A timeout and a refusal both read `down` without it. */
  reasons?: Record<string, string>;
  facts?: Record<string, unknown>;
}

/** No process behind it (nginx, a static bundle), so there is nothing to time or identify. */
export type StaticHealthData = Omit<
  HealthData,
  'instance' | 'startedAt' | 'uptimeSeconds' | 'checkedAt' | 'durationMs' | 'timings' | 'reasons'
>;

export interface HealthEnvelope<T = HealthData> {
  success: boolean;
  data: T;
}

const clean = (value: string | undefined): string => (value ?? '').trim();

// performance.now() is monotonic; Date.now() jumps when NTP steps the clock, which
// is how a 2ms check gets reported as -400ms.
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** One decimal: 0.3ms (memoized) and 0ms (not run) must not round to the same number. */
const since = (start: number): number => Math.round((now() - start) * 10) / 10;

// Real process start, not module-LOAD time: a lazily-imported Next route handler can
// load minutes after boot and would otherwise report a fresh uptime for a container
// that has been up for hours.
//
// performance.timeOrigin, NOT Node's process-uptime API. Both give the same instant to
// the millisecond, but that one is Node-only, and Next detects Node APIs in Edge
// Runtime bundles STATICALLY - a `typeof` guard does not save you, because the check
// never runs. This module is re-exported from shared barrels that middleware imports,
// so a single Node API here 500s every gated route in an app that never knowingly
// touched the health kit. That happened (admin, 2026-08-10). timeOrigin is a Web API
// present in Node, the Edge Runtime and browsers alike.
//
// Keep this module free of Node APIs - `test/edge-safety.test.ts` enforces it, and it
// scans raw source INCLUDING comments, so the forbidden names cannot be spelled here
// even in prose: tsc emits comments into dist, and not every downstream analyzer
// parses an AST rather than grepping.
function processStart(): Date {
  return new Date(typeof performance !== 'undefined' ? performance.timeOrigin : Date.now());
}

const STARTED_AT = processStart();

// Stashed on globalThis, not just module scope: Next can load one module into several
// bundle contexts in a single process, and a per-context id would look like a replica
// changing between requests - the exact signal `instance` exists to make trustworthy.
const INSTANCE_KEY = Symbol.for('agentage.observability.instance');

function resolveInstance(): string {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[INSTANCE_KEY];
  if (typeof existing === 'string') return existing;
  const uuid = globalThis.crypto?.randomUUID?.();
  const id = (uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`)
    .replace(/-/g, '')
    .slice(0, 8);
  host[INSTANCE_KEY] = id;
  return id;
}

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
  timings?: Record<string, number>;
  reasons?: Record<string, string>;
  /** Counts and sizes only, never state, so a probe never has to type-sniff. */
  facts?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  startedAt?: Date;
  /** Injected by `resolveHealth`; defaults to now. */
  checkedAt?: Date;
  durationMs?: number;
}

const present = <T extends object>(key: string, value: T | undefined) =>
  value && Object.keys(value).length ? { [key]: value } : {};

export function healthEnvelope(service?: string, options: HealthOptions = {}): HealthEnvelope {
  const env = options.env ?? process.env;
  const startedAt = options.startedAt ?? STARTED_AT;
  const checkedAt = options.checkedAt ?? new Date();
  const status = options.status ?? statusFromChecks(options.checks);
  return {
    success: options.success ?? status !== 'unavailable',
    data: {
      status,
      service: resolveServiceName(service, env),
      instance: resolveInstance(),
      ...provenance(env),
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((checkedAt.getTime() - startedAt.getTime()) / 1000),
      checkedAt: checkedAt.toISOString(),
      durationMs: options.durationMs ?? 0,
      ...present('checks', options.checks),
      ...present('timings', options.timings),
      ...present('reasons', options.reasons),
      ...present('facts', options.facts),
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

/** What one check actually cost, and why it failed if it did. */
export interface CheckOutcome {
  state: CheckState;
  durationMs: number;
  reason?: string;
}

// Kept well under the container HEALTHCHECK --timeout so a hung dependency
// reports as down rather than hanging the probe itself.
const DEFAULT_CHECK_TIMEOUT_MS = 1000;

// A stack trace is not an operator-facing reason, and an unbounded message from a
// driver can be kilobytes on a public endpoint.
const MAX_REASON_CHARS = 200;

const describeError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  const flat = message.replace(/\s+/g, ' ').trim() || 'threw a non-error';
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}...` : flat;
};

const asState = (value: CheckState | boolean): CheckState =>
  typeof value === 'boolean' ? (value ? 'ok' : 'down') : value;

const failState = (check: HealthCheck): CheckState => (check.optional ? 'degraded' : 'down');

async function runCheck(check: HealthCheck, defaultTimeoutMs: number): Promise<CheckOutcome> {
  const timeoutMs = check.timeoutMs ?? defaultTimeoutMs;
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          state: failState(check),
          durationMs: since(started),
          reason: `timed out after ${timeoutMs}ms`,
        }),
      timeoutMs
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve(check.run()).then((value) => ({
        state: asState(value),
        durationMs: since(started),
      })),
      expiry,
    ]);
  } catch (err) {
    return { state: failState(check), durationMs: since(started), reason: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Detailed form: states, per-check timings and failure reasons. */
export async function runCheckOutcomes(
  checks: HealthCheck[] = [],
  defaultTimeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<Record<string, CheckOutcome>> {
  const outcomes = await Promise.all(checks.map((check) => runCheck(check, defaultTimeoutMs)));
  return Object.fromEntries(checks.map((check, i) => [check.name, outcomes[i]]));
}

export async function runChecks(
  checks: HealthCheck[] = [],
  defaultTimeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS
): Promise<Record<string, CheckState>> {
  const outcomes = await runCheckOutcomes(checks, defaultTimeoutMs);
  return Object.fromEntries(Object.entries(outcomes).map(([name, o]) => [name, o.state]));
}

export interface HealthSourceOptions {
  service?: string;
  checks?: HealthCheck[];
  facts?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  checkTimeoutMs?: number;
  /** Facts get the same budget as a check: a fact off a wedged DB must not hang /health. */
  factsTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface FactsOutcome {
  facts?: Record<string, unknown>;
  durationMs: number;
  reason?: string;
}

// Facts are decoration; a throwing producer must never turn a healthy service red.
// Bounded like a check, because unbounded is how /health outlives the container
// HEALTHCHECK timeout and Swarm kills a task that was only ever slow to count rows.
async function safeFacts(
  produce: NonNullable<HealthSourceOptions['facts']>,
  timeoutMs: number
): Promise<FactsOutcome> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<FactsOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ durationMs: since(started), reason: `timed out after ${timeoutMs}ms` }),
      timeoutMs
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve(produce()).then((facts) => ({ facts, durationMs: since(started) })),
      expiry,
    ]);
  } catch (err) {
    return { durationMs: since(started), reason: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveHealth(
  options: HealthSourceOptions = {}
): Promise<{ envelope: HealthEnvelope; httpStatus: number }> {
  const started = now();
  const [outcomes, factsOutcome] = await Promise.all([
    options.checks?.length
      ? runCheckOutcomes(options.checks, options.checkTimeoutMs)
      : Promise.resolve(undefined),
    options.facts
      ? safeFacts(options.facts, options.factsTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS)
      : Promise.resolve(undefined),
  ]);

  const checks: Record<string, CheckState> = {};
  const timings: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  for (const [name, outcome] of Object.entries(outcomes ?? {})) {
    checks[name] = outcome.state;
    timings[name] = outcome.durationMs;
    if (outcome.reason) reasons[name] = outcome.reason;
  }
  if (factsOutcome) {
    timings.facts = factsOutcome.durationMs;
    if (factsOutcome.reason) reasons.facts = factsOutcome.reason;
  }

  const envelope = healthEnvelope(options.service, {
    checks: outcomes ? checks : undefined,
    timings,
    reasons,
    facts: factsOutcome?.facts,
    env: options.env,
    durationMs: since(started),
  });
  return { envelope, httpStatus: httpStatusFor(envelope.data.status) };
}

// Same numbers as `timings`, in the standard header, so the split shows up in browser
// devtools and in any proxy log without parsing the body.
const TOKEN = /[^A-Za-z0-9_-]/g;

export function serverTimingHeader(data: HealthData): string {
  const parts = [`health;dur=${data.durationMs}`];
  for (const [name, ms] of Object.entries(data.timings ?? {})) {
    parts.push(`${name.replace(TOKEN, '_')};dur=${ms}`);
  }
  return parts.join(', ');
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
    res.setHeader('Server-Timing', serverTimingHeader(envelope.data));
    res.status(httpStatus);
    res.json(envelope);
  };
}

/** Next App Router route handler body. Pair with `export const dynamic = 'force-dynamic'`. */
export async function healthResponse(options: HealthSourceOptions = {}): Promise<Response> {
  const { envelope, httpStatus } = await resolveHealth(options);
  return new Response(JSON.stringify(envelope), {
    status: httpStatus,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'server-timing': serverTimingHeader(envelope.data),
    },
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
    ...present('checks', options.checks),
    ...present('facts', options.facts),
  };
  return JSON.stringify({
    success: status !== 'unavailable',
    data,
  } satisfies HealthEnvelope<StaticHealthData>);
}
