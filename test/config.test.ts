import { describe, it, expect } from 'vitest';
import { resolveTracingConfig } from '../src/config.js';

const enabled = {
  OTEL_SERVICE_NAME: 'memory-backend',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://172.31.0.1:4318',
} satisfies NodeJS.ProcessEnv;

describe('resolveTracingConfig', () => {
  it('returns null on an empty env so an unconfigured service never starts the SDK', () => {
    expect(resolveTracingConfig({})).toBeNull();
  });

  it('returns null when the endpoint is missing or blank', () => {
    expect(resolveTracingConfig({ OTEL_SERVICE_NAME: 'memory-sync' })).toBeNull();
    expect(resolveTracingConfig({ ...enabled, OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBeNull();
  });

  it('returns null when the service name is missing or blank', () => {
    expect(
      resolveTracingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://172.31.0.1:4318' })
    ).toBeNull();
    expect(resolveTracingConfig({ ...enabled, OTEL_SERVICE_NAME: '  ' })).toBeNull();
  });

  it('returns null when OTEL_SDK_DISABLED is set, even with a full config', () => {
    expect(resolveTracingConfig({ ...enabled, OTEL_SDK_DISABLED: 'true' })).toBeNull();
    expect(resolveTracingConfig({ ...enabled, OTEL_SDK_DISABLED: '1' })).toBeNull();
  });

  it('resolves when both the endpoint and the service name are set', () => {
    expect(resolveTracingConfig(enabled)).toEqual({
      serviceName: 'memory-backend',
      endpoint: 'http://172.31.0.1:4318',
      serviceVersion: undefined,
    });
  });

  it('prefers the traces-specific endpoint and carries COMMIT_SHA as the version', () => {
    expect(
      resolveTracingConfig({
        ...enabled,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://172.31.0.1:4318/v1/traces',
        COMMIT_SHA: 'abc123',
      })
    ).toEqual({
      serviceName: 'memory-backend',
      endpoint: 'http://172.31.0.1:4318/v1/traces',
      serviceVersion: 'abc123',
    });
  });
});
