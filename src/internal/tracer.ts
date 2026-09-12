import { register } from 'node:module';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
  type Resource,
} from '@opentelemetry/resources';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { type TracingConfig } from './config.js';
import { instrumentations } from './instrumentations.js';
import { FetchSpanNameProcessor } from './span-names.js';

const DIAG_LEVELS: Record<string, DiagLogLevel> = {
  none: DiagLogLevel.NONE,
  error: DiagLogLevel.ERROR,
  warn: DiagLogLevel.WARN,
  info: DiagLogLevel.INFO,
  debug: DiagLogLevel.DEBUG,
  verbose: DiagLogLevel.VERBOSE,
  all: DiagLogLevel.ALL,
};

// Off by default: exporter failures must never spam the log pipeline. Set
// OTEL_LOG_LEVEL=debug on one service to debug a missing-trace report.
function configureDiagnostics(level: string | undefined): void {
  const parsed = DIAG_LEVELS[(level ?? '').trim().toLowerCase()];
  if (parsed !== undefined && parsed !== DiagLogLevel.NONE) {
    diag.setLogger(new DiagConsoleLogger(), parsed);
  }
}

function ratioFromEnv(env: NodeJS.ProcessEnv): number {
  const arg = Number.parseFloat((env.OTEL_TRACES_SAMPLER_ARG ?? '').trim());
  return Number.isFinite(arg) && arg >= 0 && arg <= 1 ? arg : 1;
}

/**
 * OTEL_TRACES_SAMPLER/_ARG per spec (estate sets parentbased_traceidratio).
 * Wired explicitly because the provider, unlike the retired NodeSDK, is not
 * contractually bound to read them. Exported for the sampler test only.
 */
export function samplerFromTraceEnv(env: NodeJS.ProcessEnv): Sampler {
  switch ((env.OTEL_TRACES_SAMPLER ?? '').trim().toLowerCase()) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratioFromEnv(env));
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratioFromEnv(env)) });
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

// NodeSDK merged the env/host/os/process/service-instance detectors on start();
// without them service.name would sit at `unknown_service:node` in SigNoz.
function resourceFor(config: TracingConfig): Resource {
  const base = config.serviceVersion
    ? defaultResource().merge(
        resourceFromAttributes({ [ATTR_SERVICE_VERSION]: config.serviceVersion })
      )
    : defaultResource();
  // Same three detectors, same order, as the NodeSDK default (verified against it).
  return base.merge(detectResources({ detectors: [envDetector, processDetector, hostDetector] }));
}

/**
 * Start the tracer. Endpoint, headers and sampler all come from the standard
 * OTEL_* env; this wires the ESM loader hook, the minimal instrumentation set,
 * the explicit OTLP pipeline and a bounded flush on shutdown.
 */
export async function startTracing(config: TracingConfig): Promise<void> {
  configureDiagnostics(process.env.OTEL_LOG_LEVEL);

  // ESM-only patching: `--require`-style monkeypatching cannot see `import`ed
  // modules, so Express/HTTP spans silently vanish without this loader hook.
  // register() (not the deprecated --experimental-loader flag) is the form that
  // survives Node 22 through 26.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const provider = new NodeTracerProvider({
    resource: resourceFor(config),
    sampler: samplerFromTraceEnv(process.env),
    // Explicit pipeline: the exporter still reads OTEL_EXPORTER_OTLP_ENDPOINT/
    // HEADERS itself. The name processor starts unmatched-route server spans as
    // `{method} (unmatched)`; matched routes get renamed at response end from
    // rpcMetadata, so only scanner probes keep the label.
    spanProcessors: [new FetchSpanNameProcessor(), new BatchSpanProcessor(new OTLPTraceExporter())],
  });

  // Defaults: W3C tracecontext + baggage propagators, AsyncLocalStorage context.
  provider.register();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: await instrumentations(),
  });

  console.log(
    `otel: tracing enabled - service ${config.serviceName} -> ${config.endpoint}` +
      (config.serviceVersion ? ` (version ${config.serviceVersion})` : '')
  );

  registerShutdownFlush(provider);
}

// Flush in-flight spans on rollout, then hand the signal back to Node's default
// handling so the exit code stays exactly what it was before instrumentation.
function registerShutdownFlush(provider: NodeTracerProvider): void {
  const FLUSH_TIMEOUT_MS = 2000;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, FLUSH_TIMEOUT_MS).unref();
      });
      void Promise.race([provider.shutdown().catch(() => undefined), timeout]).finally(() => {
        process.kill(process.pid, signal);
      });
    });
  }
}
