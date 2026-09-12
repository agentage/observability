import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Marks a handler that already emits the kit's tool events - the deprecated
 * `wrapToolHandler` stamps it, and the SDK patch skips anything carrying it, so
 * a repo mid-migration gets one wrap instead of two.
 */
export const KIT_TOOL_WRAPPED = Symbol.for('agentage.observability.mcp.toolWrapped');

export const markToolWrapped = <T extends object>(fn: T): T => {
  Object.defineProperty(fn, KIT_TOOL_WRAPPED, { value: true });
  return fn;
};

/** Whether a handler is already instrumented - the patch's idempotency check. */
export const isToolWrapped = (fn: unknown): boolean =>
  typeof fn === 'function' && KIT_TOOL_WRAPPED in fn;

export interface ToolClaim {
  claimed: boolean;
}

const claims = new AsyncLocalStorage<ToolClaim>();

/**
 * Both patch surfaces can see the same call - `McpServer` dispatches tools/call
 * through the request handler INTO the registered callback - so the outer one
 * runs the call inside a claim, and the inner one claims it. The inner layer
 * wins on purpose: `McpServer` turns a thrown tool error into an `isError`
 * result before the request handler ever sees it, so only the callback wrapper
 * can tell a real throw from a refusal.
 */
export const runClaimable = <T>(run: (claim: ToolClaim) => Promise<T>): Promise<T> => {
  const claim: ToolClaim = { claimed: false };
  return claims.run(claim, () => run(claim));
};

/** Claim the enclosing call, if any: outer layers then stay quiet. */
export const claimToolCall = (): void => {
  const claim = claims.getStore();
  if (claim) claim.claimed = true;
};
