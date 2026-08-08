import { describe, it, expect, vi, afterEach } from 'vitest';

const registerOTel = vi.hoisted(() => vi.fn());
vi.mock('@vercel/otel', () => ({ registerOTel }));

import { register } from '../src/next.js';

afterEach(() => {
  registerOTel.mockClear();
  vi.unstubAllEnvs();
});

describe('next register', () => {
  it('stays inert without the OTEL env pair', () => {
    register();
    expect(registerOTel).not.toHaveBeenCalled();
  });

  it('registers with the configured service name', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://172.31.0.1:4318');
    vi.stubEnv('OTEL_SERVICE_NAME', 'agentage-dashboard');
    register();
    expect(registerOTel).toHaveBeenCalledOnce();
    const arg = registerOTel.mock.calls[0][0] as {
      serviceName: string;
      spanProcessors: unknown[];
    };
    expect(arg.serviceName).toBe('agentage-dashboard');
    expect(arg.spanProcessors[0]).toBe('auto');
    expect(arg.spanProcessors).toHaveLength(2);
  });

  it('respects OTEL_SDK_DISABLED', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://172.31.0.1:4318');
    vi.stubEnv('OTEL_SERVICE_NAME', 'agentage-dashboard');
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    register();
    expect(registerOTel).not.toHaveBeenCalled();
  });
});
