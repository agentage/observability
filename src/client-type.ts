import {
  context as otelContext,
  propagation,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';

/**
 * Identifies the origin of a request. Real browsers send no header; internal
 * server-to-server calls and the e2e suite tag themselves, so test traffic is
 * declared rather than guessed from the user agent.
 */
export const CLIENT_TYPE_HEADER = 'x-client-type';

/** The field every telemetry lane carries: request logs, spans, edge logs. */
export const USER_TYPE_FIELD = 'user_type';

export const UserType = {
  User: 'user',
  Test: 'test',
  Service: 'service',
  Bot: 'bot',
} as const;

export type UserType = (typeof UserType)[keyof typeof UserType];

const TEST_UA = /playwright|headlesschrome|puppeteer/;
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python-requests|scan/;
const BOT_PATH = /\.php$|\.env|\/wp-|\/\.git|\/vendor\/|phpunit|phpinfo/i;

export interface ClientTypeInput {
  /** The `x-client-type` request header, if any. */
  header?: string;
  userAgent?: string;
  path?: string;
}

/**
 * Mirror of the estate classifier (web `packages/shared/src/client-type.ts` and
 * the Vector VRL rules at the edge) - keep the three in lockstep, or the admin
 * Traffic filter disagrees with itself across tabs. The header wins: it is the
 * only signal a caller states about itself.
 */
export const classifyClientType = (input: ClientTypeInput): UserType => {
  const header = (input.header ?? '').toLowerCase();
  const ua = (input.userAgent ?? '').toLowerCase();
  const path = input.path ?? '';
  if (header === UserType.Service) return UserType.Service;
  if (header === UserType.Test || TEST_UA.test(ua)) return UserType.Test;
  if (BOT_UA.test(ua) || BOT_PATH.test(path)) return UserType.Bot;
  return UserType.User;
};

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
