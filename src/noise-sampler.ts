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

/**
 * Drops probe/machinery noise the Next path emits (\@vercel/otel bypasses the
 * Node bootstrap's health filter): health-probe traces are killed at the root
 * (children follow via parent-based delegation), machinery spans individually.
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
    if (spanKind === SpanKind.SERVER) {
      const target = String(
        attributes['http.target'] ?? attributes['url.path'] ?? spanName.split(' ')[1] ?? ''
      );
      if (isHealthProbePath(target)) return { decision: SamplingDecision.NOT_RECORD };
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
