import { describe, it, expect } from 'vitest';
import { propagation, ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { isHealthProbePath } from '../src/internal/config.js';
import { samplerFromTraceEnv } from '../src/internal/tracer.js';

const TRACE_ID = 'a3ce929d0e0e4736aab7ab4f8422d25c';

const decide = (env: NodeJS.ProcessEnv) =>
  samplerFromTraceEnv(env).shouldSample(ROOT_CONTEXT, TRACE_ID, 'GET /x', SpanKind.SERVER, {}, [])
    .decision;

describe('isHealthProbePath', () => {
  it('matches the estate health endpoints, query included', () => {
    expect(isHealthProbePath('/health')).toBe(true);
    expect(isHealthProbePath('/api/health')).toBe(true);
    expect(isHealthProbePath('/status')).toBe(true);
    expect(isHealthProbePath('/hc')).toBe(true);
    expect(isHealthProbePath('/health?probe=1')).toBe(true);
  });

  it('keeps real routes', () => {
    expect(isHealthProbePath('/api/memories')).toBe(false);
    expect(isHealthProbePath('/healthz-lookalike')).toBe(false);
    expect(isHealthProbePath(undefined)).toBe(false);
  });
});

describe('samplerFromTraceEnv', () => {
  it('reads the estate contract: parentbased_traceidratio + arg', () => {
    const sampler = samplerFromTraceEnv({
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
    });
    expect(sampler.toString()).toContain('ParentBased');
    expect(sampler.toString()).toContain('TraceIdRatioBased{0.25}');
  });

  it('defaults to parentbased_always_on when the env is unset or unknown', () => {
    for (const env of [{}, { OTEL_TRACES_SAMPLER: 'nonsense' }]) {
      expect(samplerFromTraceEnv(env).toString()).toContain('ParentBased{root=AlwaysOnSampler');
      expect(decide(env)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    }
  });

  it('honours the non-parent variants', () => {
    expect(decide({ OTEL_TRACES_SAMPLER: 'always_off' })).toBe(SamplingDecision.NOT_RECORD);
    expect(decide({ OTEL_TRACES_SAMPLER: 'always_on' })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(
      samplerFromTraceEnv({
        OTEL_TRACES_SAMPLER: 'traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '0.5',
      }).toString()
    ).toBe('TraceIdRatioBased{0.5}');
    expect(
      samplerFromTraceEnv({ OTEL_TRACES_SAMPLER: 'parentbased_always_off' }).toString()
    ).toContain('AlwaysOffSampler');
  });

  it('falls back to always-on ratio when the arg is blank or out of range', () => {
    for (const arg of ['', 'abc', '-1', '2']) {
      expect(
        samplerFromTraceEnv({
          OTEL_TRACES_SAMPLER: 'traceidratio',
          OTEL_TRACES_SAMPLER_ARG: arg,
        }).toString()
      ).toBe('TraceIdRatioBased{1}');
    }
  });
});

describe('provider registration defaults', () => {
  it('registers the W3C tracecontext + baggage propagators', () => {
    new NodeTracerProvider().register();
    expect(propagation.fields()).toEqual(expect.arrayContaining(['traceparent', 'baggage']));
  });
});
