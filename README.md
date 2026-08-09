# @agentage/observability

The shared observability kit for agentage services. One package, four things:

- **Traces** - an OTLP bootstrap preloaded via `node --import`; auto-instruments
  HTTP/Express/fetch for pure-ESM services and Next.js standalone servers.
- **Logs** - a pino preset: JSON to stdout with a standard shape (`service`,
  `level`, `msg`, `err`), plus `trace_id`/`span_id` injected from the active
  span so every log line links to its trace in SigNoz. `stream: 'stderr'` for
  stdio MCP servers (stdout there is the JSON-RPC channel).
- **Errors** - `captureError(log, err, ctx)`: one call writes the structured
  error log AND flags the active span (recordException + ERROR status).
- **Health** - `@agentage/observability/health`: the one `/health` envelope
  every service in the estate returns, with `service` defaulting to
  `OTEL_SERVICE_NAME` so health and telemetry always name the same thing.

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

## Health

One envelope, every service. Contract: vault `specs/health-endpoints`.

```jsonc
{
  "success": true,
  "data": {
    "status": "ok", // ok | degraded | unavailable
    "service": "memory-mcp", // defaults to OTEL_SERVICE_NAME
    "version": "21150d69...",
    "commit": "21150d6",
    "buildTime": "2026-08-09T10:08:07Z", // ISO or null, never ""
    "startedAt": "...",
    "uptimeSeconds": 590,
    "checks": { "store": "ok" }, // ok | degraded | down | skipped
    "facts": { "memories": 412 }, // counts only, never state
  },
}
```

`status` is the worst check: any `down` makes it `unavailable` (HTTP 503), any
`degraded` makes it `degraded` (still 200). A dependency the service can survive
without must report `degraded`, not `down`. `data` is always present, including
on a 503, so a probe reads the outage instead of an empty body.

**Express** - mount on `/health`, and on `/api/health` where the edge routes
only `/api`:

```ts
import { createHealthHandler } from '@agentage/observability/health';

const health = createHealthHandler({
  checks: [{ name: 'store', run: () => store.reachable(), timeoutMs: 500 }],
  facts: () => ({ memories: store.count() }),
});
app.get('/health', health);
```

A check may return a `CheckState` or a boolean, and may throw, reject or hang:
it is timed out (1s default) and read as `down`, or `degraded` when
`optional: true`. Facts are decoration - a throwing producer is dropped, never
reddening the service.

**Next App Router** - `src/app/health/route.ts`:

```ts
import { healthResponse } from '@agentage/observability/health';

// Never prerender, or commit/buildTime are baked at build instead of read from
// the running container.
export const dynamic = 'force-dynamic';
export const GET = () => healthResponse();
```

Exclude the route from the auth middleware matcher: a probe must not chase a
redirect chain to the sign-in page.

**Static images with no Node process** (nginx, a built SPA) - generate the
payload in a build stage and serve it from an exact-match location declared
_before_ any SPA or redirect fallback, or every path answers 200 and the probe
asserts nothing:

```ts
import { staticHealthJson } from '@agentage/observability/health';
// -> one line, no startedAt/uptimeSeconds (there is no process to time)
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

## What gets traced (minimal by design)

Node services emit exactly: one SERVER span per request (`{method} {route}`,
status code, duration; scanner probes on unmatched routes = `{method}
(unmatched)`; health probes never recorded) plus CLIENT spans for outbound
http/fetch calls (which also carry W3C propagation to the next service).
No Express layer spans, no fs/dns/db auto-spans. Next apps mirror this via the
`/next` entry (noise sampler + span-name normalizer).

Depth is intentional, not automatic:

```ts
import { withSpan } from '@agentage/observability';

await withSpan('store.read', () => store.read(id), { memory: id });
```

## Why the loader hook

`bootstrap.js` calls `module.register()` with
`@opentelemetry/instrumentation/hook.mjs` - the supported replacement for the
deprecated `--experimental-loader` flag, and the only way to patch pure-ESM
imports. fs/net/dns auto-instrumentations are disabled: they bury request
traces under noise (git shells out constantly in memory-mcp and sync).
