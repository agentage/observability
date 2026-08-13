import type { Logger } from 'pino';
import { redactArgs, type ClientErrorEvent } from './error-event.js';

/** Structurally typed so the kit stays dependency-light - no express import. */
export interface CollectorRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface CollectorResponse {
  status(code: number): CollectorResponse;
  end(body?: unknown): unknown;
}

export interface CollectorOptions {
  /** Exact `Origin` values allowed to post; `'*'` accepts any. */
  allowOrigins: string[];
  /** Default 64KB, checked against content-length. */
  maxBodyBytes?: number;
  /** Extra events in one request are dropped, not rejected. Default 20. */
  maxEventsPerRequest?: number;
}

export type CollectorHandler = (req: CollectorRequest, res: CollectorResponse) => void;

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 20;
const MAX_STACK = 4_000;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const header = (req: CollectorRequest, name: string): string | undefined => {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

const toEvent = (raw: unknown): ClientErrorEvent | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const err = (input.err ?? {}) as Record<string, unknown>;
  const message = str(err.message);
  if (!message) return undefined;
  // redactArgs truncates the long values; the stack is kept at its own larger cap.
  const safe = redactArgs({
    type: str(err.type) ?? 'Error',
    message,
    event_id: str(input.event_id),
    ts: str(input.ts),
    route: str(input.route),
    service: str(input.service),
    url: str(input.url),
    user_agent: str(input.user_agent),
    user_id: str(input.user_id),
  }) as Record<string, string | undefined>;
  const stack = str(err.stack);
  return {
    event_id: safe.event_id ?? '',
    ts: safe.ts ?? new Date().toISOString(),
    err: {
      type: safe.type ?? 'Error',
      message: safe.message ?? message,
      ...(stack ? { stack: truncate(stack, MAX_STACK) } : {}),
    },
    ...(safe.route ? { route: safe.route } : {}),
    source: 'client',
    service: safe.service ?? 'unknown',
    ...(safe.url ? { url: safe.url } : {}),
    ...(safe.user_agent ? { user_agent: safe.user_agent } : {}),
    ...(safe.user_id ? { user_id: safe.user_id } : {}),
  };
};

/** Whitelists the reporter payload out of an untrusted body - never forwards unknown keys. */
export function parseClientEvents(body: unknown): ClientErrorEvent[] {
  let parsed: unknown = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown })?.events;
  if (!Array.isArray(list)) return [];
  return list.map(toEvent).filter((event): event is ClientErrorEvent => event !== undefined);
}

/**
 * POST endpoint for the browser reporter: origin-allowlisted, size-capped, and
 * re-logged through pino as the same `ErrorEvent` shape with `source: 'client'`.
 * Mount it with a body parser that accepts text (sendBeacon posts text/plain).
 */
export function collectorHandler(log: Logger, options: CollectorOptions): CollectorHandler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxEvents = options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS;
  const anyOrigin = options.allowOrigins.includes('*');
  // Pass `err` through as-is - re-serializing via an Error would flag the collector's own span.
  const clientLog = log.child({}, { serializers: { err: (err: unknown) => err } });
  return (req, res) => {
    if ((req.method ?? 'POST').toUpperCase() !== 'POST') {
      res.status(405).end();
      return;
    }
    const origin = header(req, 'origin');
    if (!anyOrigin && (!origin || !options.allowOrigins.includes(origin))) {
      res.status(403).end();
      return;
    }
    const length = Number(header(req, 'content-length') ?? 0);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      res.status(413).end();
      return;
    }
    for (const event of parseClientEvents(req.body).slice(0, maxEvents)) {
      clientLog.error({ ...event, error_code: event.err.type }, event.err.message);
    }
    res.status(204).end();
  };
}
