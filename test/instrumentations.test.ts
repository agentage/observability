import { describe, it, expect } from 'vitest';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { instrumentations, loadOptionalInstrumentation } from '../src/internal/instrumentations.js';

describe('probe filtering is wired in both directions', () => {
  const configOf = (list: Instrumentation[], name: string): Record<string, unknown> =>
    list.find((i) => i.instrumentationName.endsWith(name))?.getConfig() as Record<string, unknown>;

  const probes = (hook: unknown, key: string) => (path: string | null) =>
    (hook as (arg: Record<string, unknown>) => boolean)({ [key]: path });

  it('ignores http client and server requests to a probe path', async () => {
    const http = configOf(await instrumentations(), 'instrumentation-http');
    const outgoing = probes(http.ignoreOutgoingRequestHook, 'path');
    const incoming = probes(http.ignoreIncomingRequestHook, 'url');
    expect(outgoing('/health')).toBe(true);
    expect(outgoing('/api/health?probe=1')).toBe(true);
    expect(outgoing('/api/memories')).toBe(false);
    expect(outgoing(null)).toBe(false);
    expect(incoming('/health')).toBe(true);
  });

  it('ignores undici requests to a probe path', async () => {
    const undici = configOf(await instrumentations(), 'instrumentation-undici');
    const ignore = probes(undici.ignoreRequestHook, 'path');
    expect(ignore('/api/health')).toBe(true);
    expect(ignore('/hc')).toBe(true);
    expect(ignore('/api/mcps')).toBe(false);
  });
});

describe('optional datastore instrumentations', () => {
  it('loads the ones that are installed', async () => {
    const names = (await instrumentations()).map((i) => i.instrumentationName);
    expect(names).toEqual(
      expect.arrayContaining([
        '@opentelemetry/instrumentation-http',
        '@opentelemetry/instrumentation-express',
        '@opentelemetry/instrumentation-undici',
        '@opentelemetry/instrumentation-mongodb',
        '@opentelemetry/instrumentation-pg',
        '@opentelemetry/instrumentation-redis',
        '@opentelemetry/instrumentation-amqplib',
      ])
    );
  });

  it('returns an instance when the peer resolves', async () => {
    const pg = await loadOptionalInstrumentation(
      '@opentelemetry/instrumentation-pg',
      'PgInstrumentation'
    );
    expect(pg?.instrumentationName).toBe('@opentelemetry/instrumentation-pg');
  });

  it('skips silently when the peer is not installed', async () => {
    await expect(
      loadOptionalInstrumentation('@opentelemetry/instrumentation-not-installed', 'Whatever')
    ).resolves.toBeNull();
  });

  it('skips when the package resolves but the export is missing', async () => {
    await expect(
      loadOptionalInstrumentation('@opentelemetry/instrumentation-pg', 'NoSuchExport')
    ).resolves.toBeNull();
  });
});
