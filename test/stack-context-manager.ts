import { context as otelContext, ROOT_CONTEXT, type Context } from '@opentelemetry/api';

/**
 * The API ships a noop context manager, so baggage only survives `context.with`
 * once one is registered (the NodeSDK registers AsyncLocalStorage in production).
 * Synchronous stack is enough for the kit's tests.
 */
export function useStackContextManager(): void {
  let active: Context = ROOT_CONTEXT;
  otelContext.setGlobalContextManager({
    active: () => active,
    with(ctx: Context, fn: (...a: unknown[]) => unknown, thisArg: unknown, ...args: unknown[]) {
      const previous = active;
      active = ctx;
      try {
        return fn.call(thisArg, ...args);
      } finally {
        active = previous;
      }
    },
    bind: (_ctx: Context, target: unknown) => target,
    enable() {
      return this;
    },
    disable() {
      active = ROOT_CONTEXT;
      return this;
    },
  } as never);
}
