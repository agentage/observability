// The error CONTRACT (wire shapes below, derived fields further down) - one module
// so an emitter imports the error lane from a single place.
/** Where the error was raised - the admin errors page filters on it. */
export type ErrorSource = 'server' | 'client' | 'tool';

/** The `err` object pino's standard serializer emits from an Error. */
export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
}

/**
 * The one error line every service emits over pino -> Vector -> SigNoz. `service` and
 * `trace_id`/`span_id` ride along from the logger preset; `fingerprint` overrides grouping.
 */
export interface ErrorEvent {
  /** Serialized by pino from the thrown Error. */
  err: SerializedError;
  /** Templated route, never the concrete path: `/api/memories/:id`. */
  route?: string;
  method?: string;
  /** HTTP status actually sent, or 500 when the handler never got that far. */
  status?: number;
  user_id?: string;
  /** Application error code, else the root cause's system code, else `err.name`. */
  error_code?: string;
  /** Root-cause summary: `Error: getaddrinfo ENOTFOUND agentage-web_backend`. */
  cause?: string;
  /** Top in-app stack frame: `src/provision.ts:42:11 in provisionMemory`. */
  frame?: string;
  /** Explicit grouping override - collapses or splits groups by hand. */
  fingerprint?: string;
  source: ErrorSource;
}

/** The wire shape the browser reporter posts, and the only keys the collector forwards. */
export interface ClientErrorEvent {
  event_id: string;
  ts: string;
  err: SerializedError;
  route?: string;
  source: 'client';
  service: string;
  /** Full location.href - `route` is the pathname the errors page groups on. */
  url?: string;
  user_agent?: string;
  user_id?: string;
  /** The action trace id the browser minted - joins this error to its server request. */
  trace_id?: string;
}

/** What emitters pass alongside `err`; extra keys are allowed and kept. */
export type ErrorEventContext = Partial<Omit<ErrorEvent, 'err'>> & Record<string, unknown>;

const SECRET_KEY = /token|secret|password|key/i;
const MAX_VALUE_LENGTH = 200;
const MAX_DEPTH = 3;

const redactValue = (value: unknown, depth: number): unknown => {
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
  }
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH ? '[array]' : value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    return depth >= MAX_DEPTH ? '[object]' : redactRecord(value as Record<string, unknown>, depth);
  }
  return value;
};

const redactRecord = (input: Record<string, unknown>, depth: number): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactValue(value, depth + 1);
  }
  return out;
};

/** Credential-looking keys replaced, long values truncated - note bodies land in here. */
export function redactArgs(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return redactRecord(args as Record<string, unknown>, 0);
}

/** Application error code when the throwable carries one, else the error name. */
export function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.name : undefined;
}

/** Grouping override, when the throwable declares one. */
export function fingerprintOf(err: unknown): string | undefined {
  const fingerprint = (err as { fingerprint?: unknown })?.fingerprint;
  return typeof fingerprint === 'string' && fingerprint ? fingerprint : undefined;
}

/** Node system-error fields - the shape a DNS/TCP/TLS failure carries under a wrapper. */
interface SystemErrorFields {
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
}

/** The non-enumerable fields `tracedFetch` attaches to a rejected fetch error. */
interface WithCallSite {
  callSite?: unknown;
  fetchTarget?: unknown;
}

const MAX_CAUSE_DEPTH = 5;

const isError = (value: unknown): value is Error => value instanceof Error;

/** Walks `.cause`, depth-capped and cycle-safe, excluding the error itself. */
function causeChainOf(err: unknown, maxDepth = MAX_CAUSE_DEPTH): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>([err]);
  let current: unknown = isError(err) ? (err as Error & { cause?: unknown }).cause : undefined;
  while (isError(current) && chain.length < maxDepth && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return chain;
}

const hasSystemFields = (err: Error): boolean => {
  const fields = err as SystemErrorFields;
  return (
    typeof fields.code === 'string' ||
    typeof fields.errno === 'number' ||
    typeof fields.syscall === 'string'
  );
};

/**
 * Deepest cause carrying Node system-error fields, else the deepest cause at all -
 * for `TypeError: fetch failed` that is the getaddrinfo ENOTFOUND underneath.
 */
function rootCauseOf(err: unknown, maxDepth = MAX_CAUSE_DEPTH): Error | undefined {
  const chain = causeChainOf(err, maxDepth);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (hasSystemFields(chain[i])) return chain[i];
  }
  return chain[chain.length - 1];
}

/** `code` of the root cause, when it is a Node system-error style string. */
function causeCodeOf(err: unknown): string | undefined {
  const code = (rootCauseOf(err) as SystemErrorFields | undefined)?.code;
  return typeof code === 'string' && code ? code : undefined;
}

/** One-line root-cause summary: `Error: getaddrinfo ENOTFOUND agentage-web_backend`. */
function causeSummaryOf(err: unknown): string | undefined {
  const cause = rootCauseOf(err);
  if (!cause) return undefined;
  const code = (cause as SystemErrorFields).code;
  const summary = `${cause.name}: ${cause.message}`.trim();
  const suffix = typeof code === 'string' && code && !summary.includes(code) ? ` (${code})` : '';
  return `${summary}${suffix}`;
}

const NOT_IN_APP = /node_modules|[( ]node:|internal\/|webpack-internal|native code|\(native\)/;
const FRAME_LINE = /^\s*at\s+(.*)$/;
// `at fn (/abs/file.ts:42:11)` or the bare `at /abs/file.ts:42:11` form.
const FRAME_PARTS = /^(?:(.+?)\s+\()?(.+?:\d+:\d+)\)?$/;
// Greedy prefix so the DEEPEST marker wins: /app/src/x.ts -> src/x.ts.
const APP_PATH = /^.*\/((?:src|app|apps|lib|packages|dist)\/.+)$/;

const shortenPath = (location: string): string => {
  const clean = location.replace(/^file:\/\//, '');
  return APP_PATH.exec(clean)?.[1] ?? clean;
};

const frameFromStack = (stack: string | undefined): string | undefined => {
  if (!stack) return undefined;
  for (const line of stack.split('\n')) {
    const raw = FRAME_LINE.exec(line)?.[1];
    if (!raw || NOT_IN_APP.test(line)) continue;
    const parts = FRAME_PARTS.exec(raw.trim());
    if (!parts) continue;
    const [, fn, location] = parts;
    const short = shortenPath(location);
    return fn ? `${short} in ${fn}` : short;
  }
  return undefined;
};

/**
 * Top in-app stack frame - the error's own stack first, then its causes, then the
 * `callSite` `tracedFetch` attached (an async fetch rejection has no app frame).
 */
function frameOf(err: unknown): string | undefined {
  if (!isError(err)) return undefined;
  const own = frameFromStack(err.stack);
  if (own) return own;
  for (const cause of causeChainOf(err)) {
    const frame = frameFromStack(cause.stack);
    if (frame) return frame;
  }
  const callSite = (err as WithCallSite).callSite;
  return typeof callSite === 'string' ? frameFromStack(callSite) : undefined;
}

/**
 * The `fetchTarget` `tracedFetch` stamped, from the error itself or any cause -
 * the throw site is usually a wrapper several levels above the failed fetch.
 */
function targetOf(err: unknown): string | undefined {
  if (!isError(err)) return undefined;
  for (const candidate of [err, ...causeChainOf(err)]) {
    const target = (candidate as WithCallSite).fetchTarget;
    if (typeof target === 'string' && target) return target;
  }
  return undefined;
}

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError']);
const TIMEOUT_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const CONNECTIVITY_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UND_ERR_SOCKET',
]);
// Postgres SQLSTATE: five chars, digits and capitals only (23505, 42P01).
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The coarse bucket an error falls into - the first split on an error dashboard. */
export type ErrorCategory = 'timeout' | 'connectivity' | 'db' | 'logic';

/**
 * Classifies by ROOT cause, so a wrapper (`TypeError: fetch failed`) never hides the
 * ENOTFOUND underneath. Anything unrecognised is `logic` - our bug until proven otherwise.
 */
function categoryOf(err: unknown): ErrorCategory {
  const root = rootCauseOf(err) ?? (isError(err) ? err : undefined);
  if (!root) return 'logic';
  const raw = (root as SystemErrorFields).code;
  const code = typeof raw === 'string' ? raw : '';
  if (TIMEOUT_NAMES.has(root.name) || TIMEOUT_CODES.has(code)) return 'timeout';
  if (CONNECTIVITY_CODES.has(code)) return 'connectivity';
  if (SQLSTATE.test(code)) return 'db';
  return 'logic';
}

/** The flat fields every emitter lifts out of a wrapped error. */
export interface ErrorFrameFields {
  cause?: string;
  frame?: string;
  error_code?: string;
  target?: string;
  category?: ErrorCategory;
}

/** Handlers catch `unknown`; the logger lifts fields off a real Error only. */
export const toError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

/**
 * The code an error line settles on: an application `code` wins, and the error
 * NAME (no code at all) loses to the root cause's system code - ENOTFOUND beats
 * TypeError for grouping. Same rule the logger applies to a lifted line.
 */
export function settledErrorCode(err: unknown): string | undefined {
  const own = errorCodeOf(err);
  const named = !own || (err instanceof Error && own === err.name);
  return named ? (causeCodeOf(err) ?? own) : own;
}

/** Cause summary, in-app frame, system `code` fallback, fetch target and category. */
export function errorFrameFields(err: unknown): ErrorFrameFields {
  const fields: ErrorFrameFields = {};
  const cause = causeSummaryOf(err);
  if (cause) fields.cause = cause;
  const frame = frameOf(err);
  if (frame) fields.frame = frame;
  const code = causeCodeOf(err);
  if (code) fields.error_code = code;
  const target = targetOf(err);
  if (target) fields.target = target;
  fields.category = categoryOf(err);
  return fields;
}
