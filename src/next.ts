import { registerOTel } from '@vercel/otel';
import { resolveTracingConfig } from './config.js';
import { FetchSpanNameProcessor } from './span-names.js';

/**
 * Next.js entry: re-export from `instrumentation.ts` -
 * `export { register } from '@agentage/observability/next';`
 * @vercel/otel is the documented Next path (Node runtime SDK + fetch spans);
 * endpoint, headers and sampler come from the same OTEL_* env as the Node
 * bootstrap, and the same unset-env rule keeps it fully inert.
 */
export function register(): void {
  const config = resolveTracingConfig(process.env);
  if (!config) return;
  registerOTel({
    serviceName: config.serviceName,
    // 'auto' keeps the default export processor; the normalizer rewrites
    // fetch-client span names to `{method} {route}` for SigNoz grouping.
    spanProcessors: ['auto', new FetchSpanNameProcessor()],
  });
}
