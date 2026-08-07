import { pino, destination, type Logger, type DestinationStream } from 'pino';
import { trace, isSpanContextValid } from '@opentelemetry/api';

export type { Logger };

export interface LoggerOptions {
  /** service.name from the estate naming registry (e.g. 'agentage-auth'). */
  service: string;
  /** Default: LOG_LEVEL env, then 'info'. */
  level?: string;
  /** 'stderr' for stdio MCP servers - stdout there IS the JSON-RPC channel. */
  stream?: 'stdout' | 'stderr';
  /** Test seam; production writes to the selected stream for the log agent. */
  destination?: DestinationStream;
}

/**
 * JSON logger to stdout (or stderr for stdio transports) - the estate log agent
 * tails container output, so no in-process shipping. Every line carries
 * `service`, and when a span is active `trace_id`/`span_id` are injected so
 * SigNoz links the log to its trace.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const logger = pino(
    {
      base: { service: opts.service },
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      mixin() {
        const ctx = trace.getActiveSpan()?.spanContext();
        return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
      },
    },
    opts.destination ?? (opts.stream === 'stderr' ? destination(2) : undefined)
  );
  return logger;
}
