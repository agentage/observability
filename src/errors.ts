import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Logger } from 'pino';

/**
 * One call = the whole error trail: a structured error log (stack included,
 * trace-correlated via the logger mixin) plus recordException + ERROR status
 * on the active span so the trace is flagged red in SigNoz. Safe without a
 * tracer: the span half is simply skipped.
 */
export function captureError(log: Logger, err: unknown, ctx?: Record<string, unknown>): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
  log.error({ err: error, ...ctx }, error.message);
}
