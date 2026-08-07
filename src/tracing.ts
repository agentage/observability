import { register } from 'node:module';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { TracingConfig } from './config.js';

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

// Metrics belong to the host otel-agent, and fs/net/dns spans bury the request
// traces they hang off (git shells out constantly in memory-mcp and sync).
const DISABLED_INSTRUMENTATIONS = [
  '@opentelemetry/instrumentation-fs',
  '@opentelemetry/instrumentation-net',
  '@opentelemetry/instrumentation-dns',
  '@opentelemetry/instrumentation-host-metrics',
  '@opentelemetry/instrumentation-runtime-node',
] as const;

function autoInstrumentations(): ReturnType<typeof getNodeAutoInstrumentations> {
  const disabled = Object.fromEntries(
    DISABLED_INSTRUMENTATIONS.map((name) => [name, { enabled: false }])
  );
  return getNodeAutoInstrumentations(disabled);
}

/**
 * Start the tracer. Endpoint, headers and sampler all come from the standard
 * OTEL_* env the SDK reads itself; this only wires the ESM loader hook, the
 * instrumentation set and a bounded flush on shutdown.
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
    instrumentations: [autoInstrumentations()],
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
