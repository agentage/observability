/** Node system-error fields - the shape a DNS/TCP/TLS failure carries under a wrapper. */
interface SystemErrorFields {
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
}

/** The non-enumerable stack `tracedFetch` attaches to a rejected fetch error. */
interface WithCallSite {
  callSite?: unknown;
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

/** The flat fields every emitter lifts out of a wrapped error. */
export interface ErrorFrameFields {
  cause?: string;
  frame?: string;
  error_code?: string;
}

/** Cause summary, in-app frame and the system `code` fallback, in one call. */
export function errorFrameFields(err: unknown): ErrorFrameFields {
  const fields: ErrorFrameFields = {};
  const cause = causeSummaryOf(err);
  if (cause) fields.cause = cause;
  const frame = frameOf(err);
  if (frame) fields.frame = frame;
  const code = causeCodeOf(err);
  if (code) fields.error_code = code;
  return fields;
}
