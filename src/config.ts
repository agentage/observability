/** Everything the tracer needs; `null` from resolveTracingConfig means "stay off". */
export interface TracingConfig {
  serviceName: string;
  endpoint: string;
  /** Image provenance (COMMIT_SHA build arg), surfaced as service.version. */
  serviceVersion?: string;
}

const TRUTHY = ['1', 'true', 'yes'];

const clean = (value: string | undefined): string => (value ?? '').trim();

/**
 * Tracing is strictly opt-in: without a collector endpoint AND a service name the
 * bootstrap must leave the process byte-identical to an uninstrumented one, so
 * local dev, tests and a token-less deploy never load or start the SDK.
 */
export function resolveTracingConfig(env: NodeJS.ProcessEnv): TracingConfig | null {
  if (TRUTHY.includes(clean(env.OTEL_SDK_DISABLED).toLowerCase())) return null;

  // Signal-specific endpoint wins, matching the OTLP exporter's own precedence.
  const endpoint =
    clean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) || clean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const serviceName = clean(env.OTEL_SERVICE_NAME);
  if (!endpoint || !serviceName) return null;

  return { serviceName, endpoint, serviceVersion: clean(env.COMMIT_SHA) || undefined };
}

// Health/readiness probes fire every 15s per task and carry no signal, so the
// tracer drops their inbound spans.
const HEALTH_PATHS = new Set(['/health', '/api/health', '/status']);

export function isHealthProbePath(url: string | undefined): boolean {
  return HEALTH_PATHS.has((url ?? '').split('?')[0]);
}
