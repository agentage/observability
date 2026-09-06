import { describe, it, expect } from 'vitest';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { isHealthProbePath } from '../src/config.js';
import { instrumentations } from '../src/tracing.js';

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

describe('probe filtering is wired in both directions', () => {
  const configOf = (list: Instrumentation[], name: string): Record<string, unknown> =>
    list.find((i) => i.instrumentationName.endsWith(name))?.getConfig() as Record<string, unknown>;

  const probes = (hook: unknown, key: string) => (path: string | null) =>
    (hook as (arg: Record<string, unknown>) => boolean)({ [key]: path });

  it('ignores http client and server requests to a probe path', () => {
    const http = configOf(instrumentations(), 'instrumentation-http');
    const outgoing = probes(http.ignoreOutgoingRequestHook, 'path');
    const incoming = probes(http.ignoreIncomingRequestHook, 'url');
    expect(outgoing('/health')).toBe(true);
    expect(outgoing('/api/health?probe=1')).toBe(true);
    expect(outgoing('/api/memories')).toBe(false);
    expect(outgoing(null)).toBe(false);
    expect(incoming('/health')).toBe(true);
  });

  it('ignores undici requests to a probe path', () => {
    const undici = configOf(instrumentations(), 'instrumentation-undici');
    const ignore = probes(undici.ignoreRequestHook, 'path');
    expect(ignore('/api/health')).toBe(true);
    expect(ignore('/hc')).toBe(true);
    expect(ignore('/api/mcps')).toBe(false);
  });
});
