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
    "instance": "b82fc8d3", // random per process
    "version": "21150d69...",
    "commit": "21150d6",
    "buildTime": "2026-08-09T10:08:07Z", // ISO or null, never ""
    "startedAt": "...",
    "uptimeSeconds": 590,
    "checkedAt": "2026-08-10T01:04:40.586Z", // when THIS payload was computed
    "durationMs": 22.7, // total server-side cost
    "checks": { "store": "ok" }, // ok | degraded | down | skipped
    "timings": { "store": 21.5, "facts": 1.1 }, // per check, plus facts
    "reasons": { "search": "timed out after 60ms" }, // only when not ok
    "facts": { "memories": 412 }, // counts only, never state
  },
}
```

`status` is the worst check: any `down` makes it `unavailable` (HTTP 503), any
`degraded` makes it `degraded` (still 200). A dependency the service can survive
without must report `degraded`, not `down`. `data` is always present, including
on a 503, so a probe reads the outage instead of an empty body.

### Reading the timing fields

They exist to answer three questions a status word cannot:

- **Is this response cached?** `checkedAt` advances on every request. Frozen
  across two probes means something in front of the service is serving a copy -
  a CDN, a proxy, or a Next route that lost `force-dynamic`.
- **Is this check real, or memoized?** A `timings` entry near `0` is a value the
  service already had; a real round trip costs milliseconds. `"db": "ok"` alone
  cannot tell you which, and a memoized check keeps reporting `ok` long after
  the dependency dies.
- **Was it the service or the network?** `durationMs` is the server-side cost,
  so a probe subtracts it from its own round trip and attributes the rest to
  TLS, the edge and the wire.

`instance` is the fourth question, and the one that keeps the other three
honest: a value that changes between probes means a **different replica
answered**, not a cache and not a restart. Behind a load balancer, `uptimeSeconds`
bouncing around is otherwise indistinguishable from a crash loop. It is a random
per-process id, never the hostname - `/health` is public and must not leak
internal topology.

The same numbers go out as a `Server-Timing` header
(`health;dur=22.7, store;dur=21.5`), so the split shows in browser devtools and
proxy logs without parsing the body.

### Use it

```ts
import { health } from '@agentage/observability/health';

// Fetch-native handler: a Next route, Hono, Cloudflare Workers, Deno, Bun.
export const GET = health({
  checks: { db: () => pool.query('SELECT 1') },
  facts: () => ({ users: userCount }),
});
```

`health()` with no options is a valid **liveness** probe - process up, no
dependency checks, exactly what Kubernetes wants from liveness. Add `checks`
and the same factory is your **readiness** probe.

**Express** - `nodeHealth` is the same factory as an Express handler. Mount on
`/health`, and on `/api/health` where the edge routes only `/api`:

```ts
import { nodeHealth } from '@agentage/observability/health';

app.get(
  '/health',
  nodeHealth({
    checks: {
      store: { run: () => store.reachable(), timeoutMs: 500 },
      cache: { run: () => redis.ping(), optional: true },
    },
    facts: () => ({ memories: store.count() }),
  })
);
```

A check is a bare function per key, or `{ run, timeoutMs, optional }` when it
needs either knob (the named-array form from earlier releases works unchanged).
It may return a `CheckState` or a boolean, and may throw, reject or hang:
it is timed out (1s default) and read as `down`, or `degraded` when
`optional: true`, with the reason recorded under `reasons`. Facts are
decoration - a throwing producer is dropped, never reddening the service - and
are bounded by the same 1s budget (`factsTimeoutMs`). Do not let a facts
producer run unbounded: `/health` outliving the container `HEALTHCHECK
--timeout` is how Swarm kills a task that was only ever slow to count rows.

**Next App Router** - `src/app/health/route.ts`:

```ts
import { health } from '@agentage/observability/health';

// Never prerender, or commit/buildTime are baked at build instead of read from
// the running container.
export const dynamic = 'force-dynamic';
export const GET = health();
```

Exclude the route from the auth middleware matcher: a probe must not chase a
redirect chain to the sign-in page.

**Static images with no Node process** (nginx, a built SPA) - generate the
payload in a build stage and serve it from an exact-match location declared
_before_ any SPA or redirect fallback, or every path answers 200 and the probe
asserts nothing:

```ts
import { staticHealth } from '@agentage/observability/health';
// -> one line, no startedAt/uptimeSeconds (there is no process to time)
```

`createHealthHandler`, `healthResponse` and `staticHealthJson` remain exported
and unchanged; `health`/`nodeHealth`/`staticHealth` are the same factories under
the simpler names.

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

### Request paths are templated, not concrete

On a SERVER span where the instrumentation matched a route, `url.path` carries the
route **template** rather than the concrete target, and `url.full` is dropped. On a
content route the concrete path is the customer's own file path - as revealing as
the body - and the template groups identically anyway.

```
url.path   /v1/memories/:param/notes/:path     (not .../notes/00_INBOX/2026-08-04_bugs.md)
```

Unmatched paths stay verbatim: scanner probes and static assets are not user
content, and keeping them is what makes a routing regression visible. Express
routes registered as a `RegExp` are un-mangled from their regex source at the same
point, so they are readable and usable as a facet.

## Why the loader hook

`bootstrap.js` calls `module.register()` with
`@opentelemetry/instrumentation/hook.mjs` - the supported replacement for the
deprecated `--experimental-loader` flag, and the only way to patch pure-ESM
imports. fs/net/dns auto-instrumentations are disabled: they bury request
traces under noise (git shells out constantly in memory-mcp and sync).
