import { SpanKind, type Attributes, type Context, type Link } from '@opentelemetry/api';
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SamplingResult,
} from '@opentelemetry/sdk-trace-base';
import { isHealthProbePath } from './config.js';

// Next machinery spans: sub-ms, no route information, and they dominate the
// operations list (143x `resolve page components` on a quiet site). The spans
// that carry routes (`render route (app) X`, `executing api route (app) X`) stay.
const MACHINERY = new Set(['resolve page components', 'resolve segment modules', 'start response']);

// Server spans carry the path, client spans the absolute URL.
const PROBE_ATTRS = ['http.target', 'url.path', 'url.full', 'http.url'] as const;

const pathnameOf = (value: string): string => {
  if (!value.includes('://')) return value;
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
};

// Last name token, not the second: at shouldSample time a client span is still
// @vercel/otel's raw `fetch GET {url}`; FetchSpanNameProcessor renames it later.
const probeTargetOf = (attributes: Attributes, spanName: string): string => {
  for (const key of PROBE_ATTRS) {
    const value = attributes[key];
    if (value !== undefined && value !== null) return pathnameOf(String(value));
  }
  const parts = spanName.split(' ');
  return parts.length > 1 ? pathnameOf(parts[parts.length - 1]) : '';
};

/**
 * Drops probe/machinery noise the Next path emits (\@vercel/otel bypasses the
 * Node bootstrap's health filter): health-probe traces are killed at the root
 * (children follow via parent-based delegation), machinery spans individually.
 * Outbound probes go too - a page polling `/health` is telling you about the
 * probed service, and that answer lives in its app state, not in a span. A
 * service that genuinely wants one records it with `span()`.
 * Everything else defers to the wrapped sampler.
 */
export class NextNoiseSampler implements Sampler {
  constructor(private readonly delegate: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    if (spanKind === SpanKind.SERVER || spanKind === SpanKind.CLIENT) {
      if (isHealthProbePath(probeTargetOf(attributes, spanName))) {
        return { decision: SamplingDecision.NOT_RECORD };
      }
    }
    if (spanKind === SpanKind.INTERNAL && MACHINERY.has(spanName)) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `NextNoiseSampler(${this.delegate.toString()})`;
  }
}

/**
 * registerOTel's `traceSampler` overrides the SDK's own env handling, so this
 * replicates the estate contract: parentbased_traceidratio with
 * OTEL_TRACES_SAMPLER_ARG (absent/invalid/>=1 -> always-on root).
 */
export function samplerFromEnv(env: NodeJS.ProcessEnv): Sampler {
  const arg = Number.parseFloat((env.OTEL_TRACES_SAMPLER_ARG ?? '').trim());
  const root =
    Number.isFinite(arg) && arg >= 0 && arg < 1
      ? new TraceIdRatioBasedSampler(arg)
      : new AlwaysOnSampler();
  return new NextNoiseSampler(new ParentBasedSampler({ root }));
}
