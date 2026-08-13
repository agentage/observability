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
  /** Application error code, else `err.name`. */
  error_code?: string;
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
}

/** What emitters pass to `captureError`; extra keys are allowed and kept. */
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
