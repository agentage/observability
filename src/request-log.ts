import type { Logger } from 'pino';
import { readableRoute, routeFromUrl } from './span-names.js';

/** Structurally typed so the kit stays dependency-light - no express import. */
export interface RequestLogRequest {
  method: string;
  path: string;
  /** Full mount-relative-free URL; the only path stable after router rewrites. */
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown } | null;
}

export interface RequestLogResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

export interface RequestLogOptions {
  /**
   * Traffic classifier behind `user_type`. An injection point rather than a
   * built-in: a shared classifier would drag a product dependency into the kit.
   * The field is omitted when no classifier is given.
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

const defaultUserId = (req: RequestLogRequest): string | undefined => {
  const id = (req as { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' ? id : undefined;
};

// A router index route ('/') mounted at /api/x yields baseUrl+'/' = '/api/x/';
// drop the trailing slash so it groups with the inventory's '/api/x'.
const dropTrailingSlash = (route: string): string =>
  route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;

/**
 * Matched pattern (`/api/memories/:id`), so records group instead of fragmenting
 * on ids. Two fallbacks to `routeFromUrl(originalPath)`: no `req.route` (404s,
 * rate-limited requests), and a route Express matched by RegExp - there
 * `route.path` is the regex SOURCE, not a template (agentage-auth mounts Better
 * Auth behind one regex). `readableRoute` rewrites regex sources and only those,
 * so a rewrite is the detector.
 */
const routeOf = (req: RequestLogRequest, originalPath: string): string => {
  const template = req.route?.path;
  if (template === undefined || template === null)
    return dropTrailingSlash(routeFromUrl(originalPath));
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
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const userType = options.classify?.(req);
      log.info(
        {
          kind: 'http',
          method: req.method,
          path: originalPath,
          route: routeOf(req, originalPath),
          status: res.statusCode,
          duration_ms: Math.round(durationMs),
          user_id: userId(req),
          ...(userType === undefined ? {} : { user_type: userType }),
        },
        message
      );
    });
    next();
  };
}
