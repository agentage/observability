import { register } from 'node:module';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { isHealthProbePath, type TracingConfig } from './config.js';
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

// Minimal by design (owner directive: "just http requests, response code and
// timings"): ONE server span per request + client spans for outbound calls.
// - http: server + https-client spans, health probes never recorded
// - express: creates ZERO spans (every layer type ignored) - it exists solely
//   for route attribution: rpcMetadata.route is set BEFORE the ignore check
//   (verified in source), so server spans still get `{method} {route}` names
// - undici: outbound fetch() spans + W3C propagation to the next service
// Depth beyond that is intentional: use withSpan() in app code.
function instrumentations(): (
  HttpInstrumentation | ExpressInstrumentation | UndiciInstrumentation
)[] {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => isHealthProbePath(req.url),
    }),
    new ExpressInstrumentation({
      ignoreLayersType: [
        ExpressLayerType.MIDDLEWARE,
        ExpressLayerType.ROUTER,
        ExpressLayerType.REQUEST_HANDLER,
      ],
    }),
    new UndiciInstrumentation(),
  ];
}

/**
 * Start the tracer. Endpoint, headers and sampler all come from the standard
 * OTEL_* env; this wires the ESM loader hook, the minimal instrumentation set,
 * the explicit OTLP pipeline and a bounded flush on shutdown.
 */
export function startTracing(config: TracingConfig): void {
  configureDiagnostics(process.env.OTEL_LOG_LEVEL);

  // ESM-only patching: `--require`-style monkeypatching cannot see `import`ed
  // modules, so Express/HTTP spans silently vanish without this loader hook.
  // register() (not the deprecated --experimental-loader flag) is the form that
  // survives Node 22 through 26.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const sdk = new NodeSDK({
    resource: config.serviceVersion
      ? defaultResource().merge(
          resourceFromAttributes({ [ATTR_SERVICE_VERSION]: config.serviceVersion })
        )
      : defaultResource(),
    instrumentations: instrumentations(),
    // Explicit pipeline (NodeSDK skips its env autodetection when spanProcessors
    // is set): the exporter still reads OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS
    // itself. The name processor starts unmatched-route server spans as
    // `{method} (unmatched)`; matched routes get renamed at response end from
    // rpcMetadata, so only scanner probes keep the label.
    spanProcessors: [new FetchSpanNameProcessor(), new BatchSpanProcessor(new OTLPTraceExporter())],
  });

  sdk.start();
  console.log(
    `otel: tracing enabled - service ${config.serviceName} -> ${config.endpoint}` +
      (config.serviceVersion ? ` (version ${config.serviceVersion})` : '')
  );

  registerShutdownFlush(sdk);
}

// Flush in-flight spans on rollout, then hand the signal back to Node's default
// handling so the exit code stays exactly what it was before instrumentation.
function registerShutdownFlush(sdk: NodeSDK): void {
  const FLUSH_TIMEOUT_MS = 2000;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, FLUSH_TIMEOUT_MS).unref();
      });
      void Promise.race([sdk.shutdown().catch(() => undefined), timeout]).finally(() => {
        process.kill(process.pid, signal);
      });
    });
  }
}
