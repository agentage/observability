import type { Logger } from 'pino';
import { captureError } from './errors.js';
import { errorCodeOf, fingerprintOf } from './error-event.js';

/** Structurally typed so the kit stays dependency-light - no express import. */
export interface ErrorRequest {
  method?: string;
  path?: string;
  baseUrl?: string;
  originalUrl?: string;
  route?: { path?: string };
}

export interface ErrorResponse {
  headersSent?: boolean;
  status(code: number): ErrorResponse;
  json(body: unknown): unknown;
}

export interface ErrorMiddlewareOptions {
  /** Where the user id lives on your request; defaults to `req.user.id`. */
  userId?: (req: ErrorRequest) => string | undefined;
}

export type ExpressErrorHandler = (
  err: unknown,
  req: ErrorRequest,
  res: ErrorResponse,
  next: (err?: unknown) => void
) => void;

const defaultUserId = (req: ErrorRequest): string | undefined => {
  const id = (req as { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' ? id : undefined;
};

/** Templated path, so `/api/memories/:id` groups instead of one row per id. */
const routeOf = (req: ErrorRequest): string | undefined => {
  const template = req.route?.path;
  if (!template) return req.path ?? req.originalUrl;
  const joined = `${req.baseUrl ?? ''}${template}`;
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/';
};

const statusOf = (err: unknown): number => {
  const raw = (err as { status?: unknown; statusCode?: unknown }) ?? {};
  const value = typeof raw.status === 'number' ? raw.status : raw.statusCode;
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : 500;
};

/** Express error handler: emits the standard `ErrorEvent`, answers the estate envelope. Mount last. */
export function errorMiddleware(
  log: Logger,
  options: ErrorMiddlewareOptions = {}
): ExpressErrorHandler {
  const userId = options.userId ?? defaultUserId;
  return (err, req, res, next) => {
    const status = statusOf(err);
    captureError(log, err, {
      route: routeOf(req),
      method: req.method,
      status,
      user_id: userId(req),
      error_code: errorCodeOf(err),
      fingerprint: fingerprintOf(err),
      source: 'server',
    });
    // A streamed or already-answered response can only go to Express's default handler.
    if (res.headersSent) return next(err);
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ success: false, error: { message } });
  };
}

/** The `request` Next 15 hands to `onRequestError`. */
export interface NextErrorRequest {
  path?: string;
  method?: string;
}

/** The `context` Next 15 hands to `onRequestError`. */
export interface NextErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
}

export type NextRequestErrorHandler = (
  err: unknown,
  request: NextErrorRequest,
  context: NextErrorContext
) => void;

/** Next `instrumentation.ts` hook - server render/route errors as the same `ErrorEvent`. */
export function onRequestError(log: Logger): NextRequestErrorHandler {
  return (err, request, context) => {
    captureError(log, err, {
      route: context?.routePath || request?.path,
      method: request?.method,
      status: 500,
      error_code: errorCodeOf(err),
      fingerprint: fingerprintOf(err),
      source: 'server',
      router_kind: context?.routerKind,
      route_type: context?.routeType,
    });
  };
}
