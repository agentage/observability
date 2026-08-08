import { describe, it, expect, vi } from 'vitest';
import { SpanKind, ROOT_CONTEXT } from '@opentelemetry/api';
import { SamplingDecision, type Sampler } from '@opentelemetry/sdk-trace-base';
import { NextNoiseSampler, samplerFromEnv } from '../src/noise-sampler.js';

const TRACE_ID = 'a3ce929d0e0e4736aab7ab4f8422d25c';

function sampler(): { s: NextNoiseSampler; delegate: { shouldSample: ReturnType<typeof vi.fn> } } {
  const delegate = {
    shouldSample: vi.fn().mockReturnValue({ decision: SamplingDecision.RECORD_AND_SAMPLED }),
    toString: () => 'stub',
  };
  return { s: new NextNoiseSampler(delegate as unknown as Sampler), delegate };
}

const sample = (s: NextNoiseSampler, name: string, kind: SpanKind, attrs = {}) =>
  s.shouldSample(ROOT_CONTEXT, TRACE_ID, name, kind, attrs, []);

describe('NextNoiseSampler', () => {
  it('drops health-probe server spans by attribute', () => {
    const { s, delegate } = sampler();
    expect(sample(s, 'HEAD /health', SpanKind.SERVER, { 'http.target': '/health' }).decision).toBe(
      SamplingDecision.NOT_RECORD
    );
    expect(delegate.shouldSample).not.toHaveBeenCalled();
  });

  it('drops health-probe server spans by name when attributes are absent', () => {
    const { s } = sampler();
    expect(sample(s, 'GET /api/health', SpanKind.SERVER).decision).toBe(
      SamplingDecision.NOT_RECORD
    );
  });

  it('drops Next machinery internal spans', () => {
    const { s } = sampler();
    for (const name of ['resolve page components', 'resolve segment modules', 'start response']) {
      expect(sample(s, name, SpanKind.INTERNAL).decision).toBe(SamplingDecision.NOT_RECORD);
    }
  });

  it('keeps route-carrying internal spans and real requests via the delegate', () => {
    const { s, delegate } = sampler();
    expect(sample(s, 'render route (app) /docs', SpanKind.INTERNAL).decision).toBe(
      SamplingDecision.RECORD_AND_SAMPLED
    );
    expect(sample(s, 'GET /docs', SpanKind.SERVER).decision).toBe(
      SamplingDecision.RECORD_AND_SAMPLED
    );
    expect(delegate.shouldSample).toHaveBeenCalledTimes(2);
  });

  it('does not treat client fetches to health-like paths as probes', () => {
    const { s } = sampler();
    expect(sample(s, 'GET /health', SpanKind.CLIENT).decision).toBe(
      SamplingDecision.RECORD_AND_SAMPLED
    );
  });
});

describe('samplerFromEnv', () => {
  it('wraps a ratio root when OTEL_TRACES_SAMPLER_ARG is a sub-1 ratio', () => {
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER_ARG: '0.05' }).toString()).toContain(
      'TraceIdRatioBased{0.05}'
    );
  });

  it('falls back to always-on for absent or full-rate args', () => {
    expect(samplerFromEnv({}).toString()).toContain('AlwaysOnSampler');
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER_ARG: '1.0' }).toString()).toContain(
      'AlwaysOnSampler'
    );
  });
});
