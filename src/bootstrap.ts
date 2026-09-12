// Side-effect entry loaded via `node --import @agentage/observability/bootstrap`.
// Node fully evaluates --import modules (top-level await included) before the
// app entry point, which is what lets the loader hook patch the app's imports.
import { resolveTracingConfig } from './internal/config.js';
import { installCrashCapture } from './internal/patch/crash.js';
import { installExpressPatch } from './internal/patch/express.js';
import { installFetchPatch } from './internal/patch/fetch.js';

const config = resolveTracingConfig(process.env);

// Import the SDK only when enabled - an unconfigured service must not pay the
// startup cost, and must not fail to boot if the collector is unreachable.
if (config) {
  const { startTracing } = await import('./internal/tracer.js');
  await startTracing(config);
}

// Wiring, not tracing: a service with no collector still wants its request log,
// its /health, the error envelope and a logged crash - so these run either way.
installFetchPatch();
installExpressPatch();
installCrashCapture();
