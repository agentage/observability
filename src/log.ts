import { pino, type Logger, type DestinationStream, type LogFn } from 'pino';
import { trace, isSpanContextValid, SpanStatusCode } from '@opentelemetry/api';
import { errorFrameFields } from './internal/error-fields.js';

export type { Logger };

/** @deprecated Use the `log` singleton; removed in 1.0 final. */
export interface LoggerOptions {
  /** service.name; defaults to OTEL_SERVICE_NAME, then the deliberately loud 'unknown'. */
  service?: string;
  /** Default: LOG_LEVEL env, then 'info'. */
  level?: string;
  /** Test seam; production always writes to stderr for the log agent. */
  destination?: DestinationStream;
}

// pino numeric levels: error = 50, fatal = 60.
const ERROR_LEVEL = 50;

const UNKNOWN_SERVICE = 'unknown';

// The Error in `log.error(err)` or `log.error({ err, ...ctx })`, if any.
const errorFrom = (arg: unknown): Error | undefined =>
  arg instanceof Error
    ? arg
    : arg !== null && typeof arg === 'object' && (arg as { err?: unknown }).err instanceof Error
      ? (arg as { err: Error }).err
      : undefined;

// Callers pass the error NAME as `error_code`, which is no code at all - the root
// cause's system code (ENOTFOUND) beats `TypeError` for grouping.
const reconcileCode = (err: Error, lifted: string | undefined, given: unknown): unknown => {
  const named = !given || given === err.name;
  return named && lifted ? lifted : given;
};

/** `{ err, cause, frame, target, category, error_code }` - every error line, one shape. */
const enrich = (arg: unknown, err: Error): Record<string, unknown> => {
  const ctx = arg instanceof Error ? {} : (arg as Record<string, unknown>);
  const lifted = errorFrameFields(err);
  return {
    err,
    ...lifted,
    ...ctx,
    error_code: reconcileCode(err, lifted.error_code, ctx.error_code),
  };
};

/**
 * JSON logger to stderr - stdout is the JSON-RPC channel of a stdio MCP server,
 * so one destination for every service is the only one that is always safe, and
 * the estate log agent tails both streams anyway. Every line carries `service`,
 * and when a span is active `trace_id`/`span_id` are injected so the log links
 * to its trace. `log.error(err)` / `log.fatal(err)` also lift the root cause,
 * in-app frame, fetch target, category and system code onto the line, and record
 * the exception on that span - no separate capture call.
 *
 * @deprecated Import the `log` singleton instead; removed in 1.0 final.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const logger = pino(
    {
      base: { service: opts.service || process.env.OTEL_SERVICE_NAME?.trim() || UNKNOWN_SERVICE },
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      mixin() {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
      hooks: {
        logMethod(args, method, level) {
          const err = level >= ERROR_LEVEL ? errorFrom(args[0]) : undefined;
          if (err) {
            const argv = args as unknown[];
            argv[0] = enrich(argv[0], err);
            // No message argument: default it, as pino does for a bare Error.
            if (argv.length === 1) argv.push(err.message);
            const span = trace.getActiveSpan();
            if (span) {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            }
          }
          method.apply(this, args as Parameters<LogFn>);
        },
      },
    },
    // The process's own stderr, not a private fd-2 stream: one writer keeps kit
    // lines and anything else the process prints to stderr from interleaving.
    opts.destination ?? process.stderr
  );
  return logger;
}

let instance: Logger | undefined;

// Built on first USE, never at import: a service's entry imports the kit before
// it has loaded its env, and a logger built then would be stamped 'unknown'.
const resolve = (): Logger => {
  if (instance) return instance;
  const service = process.env.OTEL_SERVICE_NAME?.trim();
  instance = createLogger({ service: service || UNKNOWN_SERVICE });
  if (!service) {
    instance.warn(
      { service_name_missing: true },
      'OTEL_SERVICE_NAME is not set - logs ship as service "unknown"'
    );
  }
  return instance;
};

/**
 * THE logger: one JSON line per event on stderr, `service` and trace ids
 * attached. No construction call, no options - a service that needs a different
 * level sets `LOG_LEVEL`, and a child logger comes from `log.child()`.
 */
export const log: Logger = new Proxy({} as Logger, {
  get(_target, property) {
    const logger = resolve();
    const value = Reflect.get(logger, property) as unknown;
    // Bound: pino's own methods read private symbols off `this`, which must be
    // the logger and not this proxy.
    return typeof value === 'function' ? value.bind(logger) : value;
  },
  set(_target, property, value) {
    return Reflect.set(resolve(), property, value);
  },
  has(_target, property) {
    return Reflect.has(resolve(), property);
  },
});
