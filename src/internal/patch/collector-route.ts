import type { Logger } from 'pino';
import { log as singleton } from '../../log.js';
import { parseClientEvents } from './collector.js';

/** Every answer: a collector endpoint is never cached and never indexed. */
const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } as const;

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface CollectorRateLimit {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface CollectorRouteOptions {
  /**
   * Extra exact origins accepted besides the request's own. `'*'` accepts any -
   * defaults to the comma-separated `OTEL_CLIENT_ERROR_ORIGINS`, so a service
   * that only ever posts same-origin needs no option at all.
   */
  allowOrigins?: string[];
  /**
   * Accept a request that sends no `Origin` at all. Default `false`: such a
   * request is only accepted when it declares `Sec-Fetch-Site: same-origin`.
   */
  allowMissingOrigin?: boolean;
  /** Default 64KB, checked against content-length. */
  maxBodyBytes?: number;
  /** Extra events in one request are dropped, not rejected. Default 20. */
  maxEventsPerRequest?: number;
  /** Process-wide sliding window; `false` disables. Default 60 per 60s. */
  rateLimit?: CollectorRateLimit | false;
  /** Test seam; defaults to the `log` singleton. */
  log?: Logger;
}

export type CollectorRouteHandler = (request: Request) => Promise<Response>;

const answer = (status: number): Response => new Response(null, { status, headers: NO_STORE });

const hostOf = (value: string): string | undefined => {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
};

// Behind Traefik the Host header is the edge's; the forwarded one is the name the
// browser typed, which is what its Origin has to match.
const selfHost = (request: Request): string | undefined =>
  request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
  request.headers.get('host') ||
  hostOf(request.url);

const originAllowed = (
  request: Request,
  allowOrigins: readonly string[],
  allowMissingOrigin: boolean
): boolean => {
  const origin = request.headers.get('origin');
  if (!origin) {
    return allowMissingOrigin || request.headers.get('sec-fetch-site') === 'same-origin';
  }
  if (allowOrigins.includes('*') || allowOrigins.includes(origin)) return true;
  const host = selfHost(request);
  return Boolean(host) && hostOf(origin) === host;
};

const slidingWindow = (config: CollectorRateLimit): (() => boolean) => {
  const hits: number[] = [];
  return () => {
    const now = Date.now();
    // Evict on call, not on a timer: an idle process must not hold a handle open.
    let kept = 0;
    for (const at of hits) if (now - at < config.windowMs) hits[kept++] = at;
    hits.length = kept;
    if (hits.length >= config.limit) return false;
    hits.push(now);
    return true;
  };
};

const envOrigins = (): string[] =>
  (process.env.OTEL_CLIENT_ERROR_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/**
 * Next App Router `POST` handler for the browser reporter: same-origin guarded,
 * size- and rate-capped, whitelisted through `parseClientEvents` and re-logged as
 * the estate `ErrorEvent` with `source: 'client'`. Pair it with
 * `export const dynamic = 'force-dynamic'`.
 */
export function collectorRoute(options: CollectorRouteOptions = {}): CollectorRouteHandler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxEvents = options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS;
  const allowOrigins = options.allowOrigins ?? envOrigins();
  const allowMissingOrigin = options.allowMissingOrigin ?? false;
  const rateLimit =
    options.rateLimit === false
      ? undefined
      : slidingWindow(
          options.rateLimit ?? { limit: DEFAULT_RATE_LIMIT, windowMs: DEFAULT_RATE_WINDOW_MS }
        );
  // Pass `err` through as-is - re-serializing via an Error would flag the collector's own span.
  let clientLog: Logger | undefined;
  const logger = (): Logger =>
    (clientLog ??= (options.log ?? singleton).child(
      {},
      { serializers: { err: (err: unknown) => err } }
    ));

  return async (request) => {
    if (request.method.toUpperCase() !== 'POST') {
      return new Response(null, { status: 405, headers: { ...NO_STORE, allow: 'POST' } });
    }
    if (!originAllowed(request, allowOrigins, allowMissingOrigin)) return answer(403);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBodyBytes) return answer(413);
    if (rateLimit && !rateLimit()) return answer(429);
    // sendBeacon posts text/plain, so the body is always read as text.
    const body = await request.text();
    // Header-only size checks trust the client; the read body is the real measure.
    if (body.length > maxBodyBytes) return answer(413);
    for (const event of parseClientEvents(body).slice(0, maxEvents)) {
      logger().error({ ...event, error_code: event.err.type }, event.err.message);
    }
    return answer(204);
  };
}
