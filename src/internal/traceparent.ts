// W3C trace-context ids minted without an SDK - the browser lane emits the exact
// wire format the servers already extract, so one id spans click -> request -> log.

/** Id widths the spec fixes: 16 bytes of trace id, 8 of span id. */
export const TRACE_ID_BYTES = 16;
export const SPAN_ID_BYTES = 8;

const VERSION = '00';

// Sampled: a real user action is worth the full trace, so ParentBased keeps it
// whole even where the service samples at a ratio.
const SAMPLED = '01';

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const ALL_ZERO = /^0+$/;

/** The `crypto` surface used - `Math.random` is the fallback, never the default. */
export interface RandomSource {
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Hex id of `bytes` length; never all-zero, which the spec rejects as invalid. */
export function randomHexId(bytes: number, source?: RandomSource): string {
  const buffer = new Uint8Array(bytes);
  if (source?.getRandomValues) source.getRandomValues(buffer);
  else for (let i = 0; i < bytes; i += 1) buffer[i] = Math.floor(Math.random() * 256);
  if (buffer.every((byte) => byte === 0)) buffer[bytes - 1] = 1;
  return hex(buffer);
}

/** `00-<trace id>-<span id>-01` - the one traceparent shape the kit emits. */
export const formatTraceparent = (traceId: string, spanId: string): string =>
  `${VERSION}-${traceId}-${spanId}-${SAMPLED}`;

/** Guards an untrusted `trace_id` before it is logged - 32 lowercase hex, non-zero. */
export const isTraceId = (value: string): boolean =>
  TRACE_ID_PATTERN.test(value) && !ALL_ZERO.test(value);
