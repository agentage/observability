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
export function causeChainOf(err: unknown, maxDepth = MAX_CAUSE_DEPTH): Error[] {
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
export function rootCauseOf(err: unknown, maxDepth = MAX_CAUSE_DEPTH): Error | undefined {
  const chain = causeChainOf(err, maxDepth);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (hasSystemFields(chain[i])) return chain[i];
  }
  return chain[chain.length - 1];
}

/** `code` of the root cause, when it is a Node system-error style string. */
export function causeCodeOf(err: unknown): string | undefined {
  const code = (rootCauseOf(err) as SystemErrorFields | undefined)?.code;
  return typeof code === 'string' && code ? code : undefined;
}

/** One-line root-cause summary: `Error: getaddrinfo ENOTFOUND agentage-web_backend`. */
export function causeSummaryOf(err: unknown): string | undefined {
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
export function frameOf(err: unknown): string | undefined {
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
export function targetOf(err: unknown): string | undefined {
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
export function categoryOf(err: unknown): ErrorCategory {
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
