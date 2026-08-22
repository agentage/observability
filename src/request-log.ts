import { context as otelContext } from '@opentelemetry/api';
import type { Logger } from 'pino';
import {
  CLIENT_TYPE_HEADER,
  classifyClientType,
  contextWithUserType,
  stampUserType,
  type UserType,
} from './client-type.js';
import { isHealthProbePath } from './config.js';
import { readableRoute, routeFromUrl } from './span-names.js';

/** Structurally typed so the kit stays dependency-light - no express import. */
export interface RequestLogRequest {
  method: string;
  path: string;
  /** Full mount-relative-free URL; the only path stable after router rewrites. */
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown } | null;
  headers?: Record<string, string | string[] | undefined>;
}

export interface RequestLogResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

export interface RequestLogOptions {
  /**
   * Traffic classifier behind `user_type`. Defaults to the kit's
   * `classifyClientType` over the `x-client-type` header, the user agent and the
   * path; pass your own to override, or `() => undefined` to drop the field.
   */
  classify?: (req: RequestLogRequest) => string | undefined;
  /** Where the user id lives on your request; defaults to `req.user.id`. */
  userId?: (req: RequestLogRequest) => string | undefined;
  /** Log message; defaults to `'request'`. */
  message?: string;
}

export type RequestLogMiddleware = (
  req: RequestLogRequest,
  res: RequestLogResponse,
  next: () => void
) => void;

const header = (req: RequestLogRequest, name: string): string | undefined => {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

const defaultClassify =
  (originalPath: string) =>
  (req: RequestLogRequest): UserType =>
    classifyClientType({
      header: header(req, CLIENT_TYPE_HEADER),
      userAgent: header(req, 'user-agent'),
      path: originalPath,
    });

const defaultUserId = (req: RequestLogRequest): string | undefined => {
  const id = (req as { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' ? id : undefined;
};

// A router index route ('/') mounted at /api/x yields baseUrl+'/' = '/api/x/';
// drop the trailing slash so it groups with the inventory's '/api/x'.
const dropTrailingSlash = (route: string): string =>
  route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;

/**
 * Single `route` value for every request no router claimed, so scanner traffic
 * cannot mint one grouping key per invented URL. The concrete target stays on
 * `path`. Same spelling the span lane already uses for an unmatched Next server
 * span, which is the literal the admin not-found fold matches on.
 */
export const UNMATCHED_ROUTE = '(unmatched)';

/** Bot URLs are arbitrary length; a readable prefix bounds the line. */
const MAX_UNMATCHED_PATH = 200;
const TRUNCATION_MARKER = '...';

const capPath = (path: string): string =>
  path.length <= MAX_UNMATCHED_PATH
    ? path
    : `${path.slice(0, MAX_UNMATCHED_PATH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;

/**
 * Matched pattern (`/api/memories/:id`), so records group instead of fragmenting
 * on ids, or `null` when no `req.route` exists (404s, rate-limited requests).
 * One fallback to `routeFromUrl(originalPath)`: a route Express matched by
 * RegExp - there `route.path` is the regex SOURCE, not a template (agentage-auth
 * mounts Better Auth behind one regex). `readableRoute` rewrites regex sources
 * and only those, so a rewrite is the detector.
 */
const matchedRouteOf = (req: RequestLogRequest, originalPath: string): string | null => {
  const template = req.route?.path;
  if (template === undefined || template === null) return null;
  const joined = `${req.baseUrl ?? ''}${String(template)}`;
  const readable = readableRoute(joined);
  return dropTrailingSlash(readable === joined ? joined : routeFromUrl(originalPath));
};

/**
 * One structured line per finished request (method/path/route/status/duration) -
 * the estate log agent tails container stdout, so no in-process shipping.
 * Register BEFORE the routers so 404s and rate-limited requests are counted too.
 * `trace_id`/`span_id` are injected by the `createLogger` mixin.
 */
export function createRequestLog(
  log: Logger,
  options: RequestLogOptions = {}
): RequestLogMiddleware {
  const userId = options.userId ?? defaultUserId;
  const message = options.message ?? 'request';
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    // Captured at entry: Express rewrites req.path/baseUrl to be router-relative
    // once a mounted router handles the request, so at 'finish' it is truncated.
    const originalPath = (req.originalUrl ?? req.path).split('?')[0];
    // Classified at entry, not at 'finish': the span and every descendant need
    // the value while the request is still running.
    const userType = (options.classify ?? defaultClassify(originalPath))(req);
    // Probes fire every few seconds per task and carry no signal; the tracer
    // already drops their spans, so both lanes agree on what a probe is.
    if (!isHealthProbePath(originalPath)) {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const matched = matchedRouteOf(req, originalPath);
        log.info(
          {
            kind: 'http',
            method: req.method,
            path: matched === null ? capPath(originalPath) : originalPath,
            route: matched ?? UNMATCHED_ROUTE,
            status: res.statusCode,
            duration_ms: Math.round(durationMs),
            user_id: userId(req),
            ...(userType === undefined ? {} : { user_type: userType }),
          },
          message
        );
      });
    }
    // Only the canonical UserType values reach spans; a custom classifier's own
    // vocabulary still lands on the log line.
    if (userType === undefined) return next();
    // Baggage, not just the span attribute: descendant spans are created by code
    // that never sees the request.
    otelContext.with(contextWithUserType(userType as UserType), () => {
      stampUserType();
      next();
    });
  };
}
