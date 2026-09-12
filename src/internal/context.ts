import {
  context as otelContext,
  createContextKey,
  propagation,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { USER_TYPE_FIELD, UserType } from './classify.js';

/** The span attribute the estate groups user traffic on. */
export const USER_ID_ATTRIBUTE = 'user.id';

const isUserType = (value: unknown): value is UserType =>
  typeof value === 'string' && Object.values(UserType).includes(value as UserType);

/**
 * A context carrying `user_type` in OTel baggage, so spans created anywhere
 * under the request - including in code that never sees the request object -
 * can stamp the same value.
 */
export const contextWithUserType = (
  userType: UserType,
  ctx: Context = otelContext.active()
): Context => {
  const baggage = propagation.getBaggage(ctx) ?? propagation.createBaggage();
  return propagation.setBaggage(ctx, baggage.setEntry(USER_TYPE_FIELD, { value: userType }));
};

/** The `user_type` carried by the active (or given) context, if it was classified. */
export const userTypeFromContext = (ctx: Context = otelContext.active()): UserType | undefined => {
  const value = propagation.getBaggage(ctx)?.getEntry(USER_TYPE_FIELD)?.value;
  return isUserType(value) ? value : undefined;
};

/**
 * Stamp `user_type` on a span from the request's context - call it when you
 * create a span the kit does not own (an MCP tool span, a worker job span).
 * Returns the stamped value, or undefined when nothing was classified.
 */
export const stampUserType = (span?: Span): UserType | undefined => {
  const userType = userTypeFromContext();
  if (!userType) return undefined;
  (span ?? trace.getActiveSpan())?.setAttribute(USER_TYPE_FIELD, userType);
  return userType;
};

/**
 * Mutable cell, not a baggage entry: `setUser(id)` takes no callback, so it has
 * to write into a scope its caller already entered. The cell rides the context,
 * so it survives every async hop the context manager propagates - and unlike a
 * module global it is per-request, not per-process.
 */
export interface UserSlot {
  id?: string;
}

const USER_SLOT = createContextKey('@agentage/observability user');

export const userSlotOf = (ctx: Context = otelContext.active()): UserSlot | undefined =>
  ctx.getValue(USER_SLOT) as UserSlot | undefined;

/** The context's own slot when it has one, else a context carrying a fresh one. */
export const enterUserScope = (
  ctx: Context = otelContext.active()
): { context: Context; slot: UserSlot } => {
  const existing = userSlotOf(ctx);
  if (existing) return { context: ctx, slot: existing };
  const slot: UserSlot = {};
  return { context: ctx.setValue(USER_SLOT, slot), slot };
};

/** The user id `setUser` put on the active (or given) context, if any. */
export const userIdFromContext = (ctx?: Context): string | undefined => userSlotOf(ctx)?.id;

/** Writes the id into the enclosing scope's slot; no scope means nothing to write to. */
export const setUserIdOnContext = (id: string | undefined): void => {
  const slot = userSlotOf();
  if (slot) slot.id = id;
};

/** Stamp `user.id` on a span from the enclosing scope, for spans the kit does not own. */
export const stampUserId = (span?: Span): string | undefined => {
  const id = userIdFromContext();
  if (!id) return undefined;
  (span ?? trace.getActiveSpan())?.setAttribute(USER_ID_ATTRIBUTE, id);
  return id;
};
