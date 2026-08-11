import { pino, destination, type Logger, type DestinationStream, type LogFn } from 'pino';
import { trace, isSpanContextValid, SpanStatusCode } from '@opentelemetry/api';

export type { Logger };

export interface LoggerOptions {
  /** service.name; defaults to OTEL_SERVICE_NAME, then the deliberately loud 'unknown'. */
  service?: string;
  /** Default: LOG_LEVEL env, then 'info'. */
  level?: string;
  /** 'stderr' for stdio MCP servers - stdout there IS the JSON-RPC channel. */
  stream?: 'stdout' | 'stderr';
  /** Test seam; production writes to the selected stream for the log agent. */
  destination?: DestinationStream;
}

// pino numeric levels: error = 50, fatal = 60.
const ERROR_LEVEL = 50;

// The Error in `log.error(err)` or `log.error({ err, ...ctx })`, if any.
const errorFrom = (arg: unknown): Error | undefined =>
  arg instanceof Error
    ? arg
    : arg !== null && typeof arg === 'object' && (arg as { err?: unknown }).err instanceof Error
      ? (arg as { err: Error }).err
      : undefined;

/**
 * JSON logger to stdout (or stderr for stdio transports) - the estate log agent
 * tails container output, so no in-process shipping. Every line carries
 * `service`, and when a span is active `trace_id`/`span_id` are injected so the
 * log links to its trace. `log.error(err)` / `log.fatal(err)` also record the
 * exception on that span and flag it red - no separate capture call.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const logger = pino(
    {
      base: { service: opts.service || process.env.OTEL_SERVICE_NAME?.trim() || 'unknown' },
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      mixin() {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
      hooks: {
        logMethod(args, method, level) {
          const err = level >= ERROR_LEVEL ? errorFrom(args[0]) : undefined;
          if (err) {
            // `{ err, ...ctx }` with no message: default it, as pino does for a bare Error.
            if (!(args[0] instanceof Error) && args.length === 1) {
              (args as unknown[]).push(err.message);
            }
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
    opts.destination ?? (opts.stream === 'stderr' ? destination(2) : undefined)
  );
  return logger;
}

/** `createLogger` under the `health()`-style name: `const log = logger()`. */
export const logger = createLogger;
