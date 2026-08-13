import { registerOTel } from '@vercel/otel';
import { resolveTracingConfig } from './config.js';
import { FetchSpanNameProcessor } from './span-names.js';
import { samplerFromEnv } from './noise-sampler.js';

// Same instrumentation.ts file exports both hooks, so it ships from this subpath too.
export {
  onRequestError,
  type NextErrorContext,
  type NextErrorRequest,
  type NextRequestErrorHandler,
} from './error-emitters.js';

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
    // Image provenance (COMMIT_SHA) - the Node bootstrap sets this via the
    // resource; the Next path must pass it explicitly.
    attributes: config.serviceVersion ? { 'service.version': config.serviceVersion } : undefined,
    // Drops health-probe traces + Next machinery spans; wraps the env ratio.
    traceSampler: samplerFromEnv(process.env),
    // 'auto' keeps the default export processor; the normalizer rewrites
    // fetch-client span names to `{method} {route}` for SigNoz grouping.
    spanProcessors: ['auto', new FetchSpanNameProcessor()],
  });
}
