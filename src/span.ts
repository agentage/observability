import {
  context as otelContext,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { enterUserScope, stampUserId, stampUserType } from './internal/context.js';

/**
 * The intentional-instrumentation API: one call = a properly parented span with
 * exception recording. This is where trace depth comes from now - the kit's
 * auto-instrumentation stays at "http request + status + timing" only.
 *
 *   await span('store.read', () => store.read(id), { memory: id });
 *
 * Inert without a started SDK (the API's noop tracer), so library code can call
 * it unconditionally.
 */
export async function span<T>(
  name: string,
  fn: (span: Span) => T | Promise<T>,
  attributes?: Attributes
): Promise<T> {
  return trace
    .getTracer('@agentage/observability')
    .startActiveSpan(name, { attributes }, async (started) => {
      stampUserType(started);
      stampUserId(started);
      // A scope of its own, so `setUser` inside the callback has somewhere to
      // write even when no request middleware opened one.
      const scope = enterUserScope();
      return otelContext.with(scope.context, async () => {
        try {
          return await fn(started);
        } catch (err) {
          started.recordException(err instanceof Error ? err : new Error(String(err)));
          started.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          started.end();
        }
      });
    });
}

/** @deprecated Renamed to `span`; removed in the next major. */
export const withSpan = span;
