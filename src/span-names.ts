import type { Context } from '@opentelemetry/api';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

// Param-shaped path segments: numeric ids, hex ids (mongo/sha), uuids.
const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** URL (or bare path) -> low-cardinality route: query dropped, id segments -> :id. */
export function routeFromUrl(url: string): string {
  let path = url;
  const proto = path.indexOf('://');
  if (proto !== -1) {
    const slash = path.indexOf('/', proto + 3);
    path = slash === -1 ? '/' : path.slice(slash);
  }
  path = path.split('?')[0].split('#')[0];
  if (path === '') return '/';
  const route = path
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/');
  return route === '' ? '/' : route;
}

/**
 * `fetch GET http://host/api/mcps?page=1` -> `GET /api/mcps` (semconv
 * `{method} {route}`). Returns null for spans that are not \@vercel/otel
 * fetch-client spans, which stay untouched.
 */
export function normalizeFetchSpanName(name: string): string | null {
  const m = /^fetch\s+([A-Z]+)\s+(\S+)$/.exec(name);
  if (!m) return null;
  return `${m[1]} ${routeFromUrl(m[2])}`;
}

/**
 * Span processor rewriting \@vercel/otel's `fetch {method} {full-url}` client
 * span names on start - the full URL (query included) makes every facet
 * combination its own operation in SigNoz, destroying grouping. The target
 * host stays available in the http.* attributes.
 */
export class FetchSpanNameProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context): void {
    const normalized = normalizeFetchSpanName(span.name);
    if (normalized) span.updateName(normalized);
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
