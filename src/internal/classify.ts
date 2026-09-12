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
// Machine HTTP clients that never send x-client-type: an SSR fetch or a script,
// not a visitor. Verbatim from the edge VRL rule.
const MACHINE_UA =
  /^(node|node-fetch|undici|axios|got|python-requests|python-urllib|aiohttp|httpx|go-http-client|curl|wget|okhttp|java|apache-httpclient|libwww|guzzlehttp|postmanruntime)([-/ ]|$)/;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Dotted quad -> uint32 via arithmetic, not shifts: `<<` yields signed 32-bit.
const toUint32 = (ip: string): number | undefined => {
  const match = IPV4.exec(ip.trim());
  if (!match) return undefined;
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
};

const prefixBits = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return 32;
  if (!/^\d{1,2}$/.test(raw)) return undefined;
  const bits = Number(raw);
  return bits <= 32 ? bits : undefined;
};

const inRange = (address: number, range: string): boolean => {
  const parts = range.trim().split('/');
  if (parts.length > 2) return false;
  const base = toUint32(parts[0] ?? '');
  const bits = prefixBits(parts[1]);
  if (base === undefined || bits === undefined) return false;
  const hostSpan = 2 ** (32 - bits);
  return Math.floor(base / hostSpan) === Math.floor(address / hostSpan);
};

/**
 * Is `ip` inside any of the IPv4 CIDRs (`57.141.20.0/22`, a bare address = /32)?
 * Malformed input never throws, it just does not match; an IPv6 address never
 * matches, so a v6 caller stays classified by its user agent.
 */
const ipInRanges = (ip: string | undefined, ranges: readonly string[] | undefined): boolean => {
  if (!ip || !ranges || ranges.length === 0) return false;
  const address = toUint32(ip);
  if (address === undefined) return false;
  return ranges.some((range) => inRange(address, range));
};

export interface ClientTypeInput {
  /** The `x-client-type` request header, if any. */
  header?: string;
  userAgent?: string;
  path?: string;
  /** Caller address, leftmost `x-forwarded-for` hop at the edge. */
  ip?: string;
  /** IPv4 CIDRs whose traffic is a bot however its user agent presents itself. */
  botIpRanges?: readonly string[];
}

/**
 * Mirror of the estate classifier (web `packages/shared/src/client-type.ts` and
 * the Vector VRL rules at the edge) - keep the three in lockstep, or the admin
 * Traffic filter disagrees with itself across tabs. The header wins: it is the
 * only signal a caller states about itself. Order is load-bearing: a scanner
 * running curl is a bot before it is a machine caller, and an empty UA is a
 * program rather than a visitor.
 */
export const classifyClientType = (input: ClientTypeInput): UserType => {
  const header = (input.header ?? '').toLowerCase();
  const ua = (input.userAgent ?? '').toLowerCase();
  const path = input.path ?? '';
  if (header === UserType.Service) return UserType.Service;
  if (header === UserType.Test || TEST_UA.test(ua)) return UserType.Test;
  if (
    header === UserType.Bot ||
    BOT_UA.test(ua) ||
    BOT_PATH.test(path) ||
    ipInRanges(input.ip, input.botIpRanges)
  ) {
    return UserType.Bot;
  }
  if (ua === '' || MACHINE_UA.test(ua)) return UserType.Service;
  return UserType.User;
};
