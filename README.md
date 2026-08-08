# @agentage/observability

The shared observability kit for agentage services. One package, three things:

- **Traces** - an OTLP bootstrap preloaded via `node --import`; auto-instruments
  HTTP/Express/fetch for pure-ESM services and Next.js standalone servers.
- **Logs** - a pino preset: JSON to stdout with a standard shape (`service`,
  `level`, `msg`, `err`), plus `trace_id`/`span_id` injected from the active
  span so every log line links to its trace in SigNoz. `stream: 'stderr'` for
  stdio MCP servers (stdout there is the JSON-RPC channel).
- **Errors** - `captureError(log, err, ctx)`: one call writes the structured
  error log AND flags the active span (recordException + ERROR status).

Everything is opt-in by env: without `OTEL_EXPORTER_OTLP_ENDPOINT` +
`OTEL_SERVICE_NAME` the SDK is never even imported and the process behaves
exactly as an uninstrumented one. Logging works regardless.

## Adopt in a service (5 lines)

1. `npm install @agentage/observability`
2. Dockerfile `CMD` (or `NODE_OPTIONS`): preload the bootstrap

   ```
   node --import @agentage/observability/bootstrap dist/index.js
   ```

   `--import`, never `--require`: CJS preloads cannot patch `import`ed modules,
   so Express/HTTP spans silently vanish.

   **Next.js apps** skip the preload: add `@vercel/otel` and a one-line
   `src/instrumentation.ts` instead -

   ```ts
   export { register } from '@agentage/observability/next';
   ```

3. Compose/env: `OTEL_SERVICE_NAME=<name from the estate naming registry>`
4. Compose/env: sampler + disabled signals (metrics come from the host agent,
   logs from the log agent):

   ```
   OTEL_TRACES_SAMPLER=parentbased_traceidratio
   OTEL_TRACES_SAMPLER_ARG=0.2
   OTEL_METRICS_EXPORTER=none
   OTEL_LOGS_EXPORTER=none
   ```

5. Deploy env (rendered, holds the secret):

   ```
   OTEL_EXPORTER_OTLP_ENDPOINT=<collector base URL>
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<ingest token>
   OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.namespace=<namespace>
   ```

   The header value is percent-encoded (`%20`, not a raw space) - the SDK
   decodes it; `,` and `=` in a token must be encoded too.

Then in code:

```ts
import { createLogger, captureError } from '@agentage/observability';

const log = createLogger({ service: 'agentage-auth' });
log.info({ route: '/health' }, 'probe ok');

try {
  await risky();
} catch (err) {
  captureError(log, err, { userId });
}
```

## Configuration

Standard `OTEL_*` env, read by the SDK itself:

| Variable                                       | Notes                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                  | Base URL; the exporter appends `/v1/traces`. Unset = tracing off. |
| `OTEL_SERVICE_NAME`                            | Required to start; use the estate naming registry.                |
| `OTEL_EXPORTER_OTLP_HEADERS`                   | `Authorization=Bearer%20<token>` - percent-encoded.               |
| `OTEL_RESOURCE_ATTRIBUTES`                     | `deployment.environment`, `service.namespace`.                    |
| `OTEL_TRACES_SAMPLER[_ARG]`                    | `parentbased_traceidratio` + ratio per service volume.            |
| `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `none` - the host agents own those signals.                       |
| `OTEL_SDK_DISABLED`                            | `true` = hard off even when configured.                           |
| `OTEL_LOG_LEVEL`                               | Unset = silent. `debug` to diagnose a missing-trace report.       |
| `COMMIT_SHA`                                   | Image build arg, surfaced as `service.version`.                   |
| `LOG_LEVEL`                                    | pino level for `createLogger` (default `info`).                   |

## Why the loader hook

`bootstrap.js` calls `module.register()` with
`@opentelemetry/instrumentation/hook.mjs` - the supported replacement for the
deprecated `--experimental-loader` flag, and the only way to patch pure-ESM
imports. fs/net/dns auto-instrumentations are disabled: they bury request
traces under noise (git shells out constantly in memory-mcp and sync).
