import { trace } from '@opentelemetry/api';
import { USER_ID_ATTRIBUTE, setUserIdOnContext } from './internal/context.js';

/**
 * Declare who the current request belongs to, once, as soon as it is known
 * (after auth). The id then rides the OTel context - so it lands on the request
 * log line, on every error event raised under it and on the active span, across
 * async hops, without being threaded through a single function signature.
 *
 * Effective inside a scope the kit opened: `createRequestLog` for an HTTP
 * request, `span()` for anything else. `setUser(undefined)` clears it.
 */
export function setUser(id: string | undefined): void {
  setUserIdOnContext(id);
  if (id) trace.getActiveSpan()?.setAttribute(USER_ID_ATTRIBUTE, id);
}
