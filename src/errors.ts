import type { Logger } from 'pino';
import type { ErrorEventContext } from './error-event.js';
import { errorFrameFields } from './error-frame.js';

/**
 * Previous name for what `log.error(err)` now does by itself on kit loggers:
 * structured error log plus recordException + ERROR status on the active span.
 * Kept so existing call sites keep working; new code just calls `log.error`.
 * The emitters use it as the low-level primitive for the `ErrorEvent` shape.
 */
export function captureError(log: Logger, err: unknown, ctx?: ErrorEventContext): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const lifted = errorFrameFields(error);
  // Emitters default `error_code` to the error NAME, which is no code at all - the
  // cause's system code (ENOTFOUND) beats `TypeError` for grouping.
  const named = !ctx?.error_code || ctx.error_code === error.name;
  const error_code = named && lifted.error_code ? lifted.error_code : ctx?.error_code;
  log.error(
    { err: error, cause: lifted.cause, frame: lifted.frame, ...ctx, error_code },
    error.message
  );
}
