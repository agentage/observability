import { diag } from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { isHealthProbePath } from './config.js';

type InstrumentationClass = new () => Instrumentation;

// Datastore/queue instrumentations are optional peers: a service that never talks
// to pg/mongodb/redis/amqplib must not carry their dependency trees.
const OPTIONAL: ReadonlyArray<readonly [string, string]> = [
  ['@opentelemetry/instrumentation-mongodb', 'MongoDBInstrumentation'],
  ['@opentelemetry/instrumentation-pg', 'PgInstrumentation'],
  ['@opentelemetry/instrumentation-redis', 'RedisInstrumentation'],
  ['@opentelemetry/instrumentation-amqplib', 'AmqplibInstrumentation'],
];

/**
 * Load one optional instrumentation, or `null` when its package is not installed.
 * Exported for the wiring test only; not part of the package's public surface.
 */
export async function loadOptionalInstrumentation(
  specifier: string,
  exportName: string
): Promise<Instrumentation | null> {
  try {
    const mod: Record<string, unknown> = await import(specifier);
    const ctor = mod[exportName];
    if (typeof ctor !== 'function') return null;
    return new (ctor as InstrumentationClass)();
  } catch {
    // Debug, not warn: "not installed" is the normal case for most services.
    diag.debug(`otel: optional instrumentation ${specifier} not installed - skipping`);
    return null;
  }
}

// Lean by design: ONE server span per request, outbound calls, datastore calls -
// and nothing else (owner directive; amended 2026-08-08 to keep db/queue spans).
// - http: server + https-client spans, health probes never recorded in either
//   direction (a system page polling /health emitted ~800 client spans/hour)
// - express: creates ZERO spans (every layer type ignored) - it exists solely
//   for route attribution: rpcMetadata.route is set BEFORE the ignore check
//   (verified in source), so server spans still get `{method} {route}` names
// - undici: outbound fetch() spans + W3C propagation to the next service
// - mongodb/pg/redis/amqplib: the estate's datastores + queues, loaded only when
//   the service installed the matching optional peer
// Further depth is intentional: use withSpan() in app code.
// Exported for the wiring test only; not part of the package's public surface.
export async function instrumentations(): Promise<Instrumentation[]> {
  const optional = await Promise.all(
    OPTIONAL.map(([specifier, exportName]) => loadOptionalInstrumentation(specifier, exportName))
  );
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => isHealthProbePath(req.url),
      ignoreOutgoingRequestHook: (req) => isHealthProbePath(req.path ?? undefined),
    }),
    new ExpressInstrumentation({
      ignoreLayersType: [
        ExpressLayerType.MIDDLEWARE,
        ExpressLayerType.ROUTER,
        ExpressLayerType.REQUEST_HANDLER,
      ],
    }),
    new UndiciInstrumentation({
      ignoreRequestHook: (req) => isHealthProbePath(req.path),
    }),
    ...optional.filter((entry): entry is Instrumentation => entry !== null),
  ];
}
