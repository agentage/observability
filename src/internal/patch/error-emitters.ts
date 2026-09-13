import { trace, isSpanContextValid } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { toError, errorCodeOf, fingerprintOf, settledErrorCode } from '../error-fields.js';
import { userIdFromContext } from '../context.js';

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
  setHeader?(name: string, value: string): unknown;
}

export interface ErrorMiddlewareOptions {
  /**
   * Where the user id lives on your request. Only consulted when the handler
   * never called `setUser`; defaults to `req.user.id`.
   */
  userId?: (req: ErrorRequest) => string | undefined;
  /**
   * Emit an `ErrorEvent` for 4xx too. Default `false`: a 404 or a validation
   * refusal is the API working, and one bad client otherwise floods the errors
   * page. The envelope is answered either way.
   */
  captureBelow500?: boolean;
  /**
   * Answer 5xx with `Internal server error` instead of the thrown message, unless
   * the error sets `expose: true`. Default `true`: a driver, git or fetch message
   * is internal detail, and the `traceId` in the same envelope is the handle that
   * ties the user's report to the full line. 4xx always keep their real message.
   */
  maskServerErrors?: boolean;
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

/** The id the response header and the envelope carry; '' when no span is active. */
const traceIdOf = (): string => {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && isSpanContextValid(ctx) ? ctx.traceId : '';
};

/** What a masked 5xx answers; the real message stays on the logged line. */
const MASKED_MESSAGE = 'Internal server error';

/** Opt-in from the thrower: this 5xx message was written for the caller to read. */
const isExposed = (err: unknown): boolean =>
  (err as { expose?: unknown } | null | undefined)?.expose === true;

/** Marks the kit's own handler so the express patch never appends a second one. */
export const KIT_ERROR_MIDDLEWARE = Symbol.for('agentage.observability.errorMiddleware');

/** Whether a handler is one of ours - the idempotency check the auto-wiring runs. */
export const isKitErrorMiddleware = (fn: unknown): boolean =>
  typeof fn === 'function' && KIT_ERROR_MIDDLEWARE in fn;

/** Express error handler: emits the standard `ErrorEvent`, answers the estate envelope. Mount last. */
export function errorMiddleware(
  log: Logger,
  options: ErrorMiddlewareOptions = {}
): ExpressErrorHandler {
  const captureBelow500 = options.captureBelow500 ?? false;
  const maskServerErrors = options.maskServerErrors ?? true;
  const handler: ExpressErrorHandler = (err, req, res, next) => {
    const status = statusOf(err);
    if (status >= 500 || captureBelow500) {
      log.error({
        err: toError(err),
        route: routeOf(req),
        method: req.method,
        status,
        user_id: options.userId ? options.userId(req) : (userIdFromContext() ?? defaultUserId(req)),
        error_code: errorCodeOf(err),
        fingerprint: fingerprintOf(err),
        source: 'server',
      });
    }
    // A streamed or already-answered response can only go to Express's default handler.
    if (res.headersSent) return next(err);
    const traceId = traceIdOf();
    // The one id a user can read off a failed call and hand to support.
    if (traceId) res.setHeader?.('X-Trace-Id', traceId);
    const message = err instanceof Error ? err.message : String(err);
    // Response-only: the line logged above keeps the full message and stack.
    const masked = maskServerErrors && status >= 500 && !isExposed(err);
    res.status(status).json({
      success: false,
      error: { code: settledErrorCode(err) ?? 'Error', message: masked ? MASKED_MESSAGE : message },
      traceId,
    });
  };
  Object.defineProperty(handler, KIT_ERROR_MIDDLEWARE, { value: true });
  return handler;
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
    log.error({
      err: toError(err),
      route: context?.routePath || request?.path,
      method: request?.method,
      status: 500,
      user_id: userIdFromContext(),
      error_code: errorCodeOf(err),
      fingerprint: fingerprintOf(err),
      source: 'server',
      router_kind: context?.routerKind,
      route_type: context?.routeType,
    });
  };
}
