import { trace, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { stampUserType } from './client-type.js';

/**
 * The intentional-instrumentation API: one call = a properly parented span with
 * exception recording. This is where trace depth comes from now - the kit's
 * auto-instrumentation stays at "http request + status + timing" only.
 *
 *   await withSpan('store.read', () => store.read(id), { memory: id });
 *
 * Inert without a started SDK (the API's noop tracer), so library code can call
 * it unconditionally.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => T | Promise<T>,
  attributes?: Attributes
): Promise<T> {
  return trace
    .getTracer('@agentage/observability')
    .startActiveSpan(name, { attributes }, async (span) => {
      stampUserType(span);
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
}
