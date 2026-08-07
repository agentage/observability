// Side-effect entry loaded via `node --import ./packages/otel/dist/bootstrap.js`.
// Node fully evaluates --import modules (top-level await included) before the
// app entry point, which is what lets the loader hook patch the app's imports.
import { resolveTracingConfig } from './config.js';

const config = resolveTracingConfig(process.env);

// Import the SDK only when enabled - an unconfigured service must not pay the
// startup cost, and must not fail to boot if the collector is unreachable.
if (config) {
  const { startTracing } = await import('./tracing.js');
  startTracing(config);
}
