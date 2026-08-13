import type { Logger } from 'pino';
import type { ErrorEventContext } from './error-event.js';

/**
 * Previous name for what `log.error(err)` now does by itself on kit loggers:
 * structured error log plus recordException + ERROR status on the active span.
 * Kept so existing call sites keep working; new code just calls `log.error`.
 * The emitters use it as the low-level primitive for the `ErrorEvent` shape.
 */
export function captureError(log: Logger, err: unknown, ctx?: ErrorEventContext): void {
  const error = err instanceof Error ? err : new Error(String(err));
  log.error({ err: error, ...ctx }, error.message);
}
