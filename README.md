# @agentage/observability

One `/health` endpoint, one log shape, one trace pipeline - for every Node service you run.

Install it, add three lines, and every service answers the same health envelope, writes
logs that link to their traces, and reports errors once instead of twice. Health works on
its own with **zero configuration**; tracing stays completely inert until you point it at a
collector.

## What is this?

Running more than a couple of services, you end up writing the same three things again and
again: a `/health` route, a logger, and some OpenTelemetry wiring. They drift. One service
calls itself `auth`, another `agentage-auth`. One `/health` returns `{ok: true}`, another
returns a bare `200`. When something breaks at 3am, none of it lines up.

This package is those three things, written once:

- **Health** - a `/health` endpoint whose answer you can actually interrogate: which checks
  ran, what each one cost, whether the reply was cached, and which replica sent it.
- **Logs** - JSON with a fixed shape, stamped with the current trace so a log line and its
  trace are one click apart - and `log.error(err)` flags that trace as failed.
- **Traces** - an OpenTelemetry bootstrap that emits one span per request instead of fifty.

Use one part or all three. The health module has **no dependencies at all** and runs on Node,
Cloudflare Workers, Deno, Bun and edge runtimes; the tracing parts only load when configured.

## Get started

```bash
npm install @agentage/observability
```

### A health endpoint, in one line

```ts
// Next.js app/health/route.ts - also Hono, Workers, Deno, Bun
import { health } from '@agentage/observability/health';

export const dynamic = 'force-dynamic'; // or commit/buildTime bake in at build time
export const GET = health();
```

That is already a valid Kubernetes **liveness** probe: the process is up, and it checks no
dependencies (which is exactly what liveness should not do). Add checks and the same
factory becomes your **readiness** probe:

```ts
export const GET = health({
  checks: {
    db: () => pool.query('SELECT 1'), // throws, rejects, hangs or false = down
    cache: { run: () => redis.ping(), timeoutMs: 250, optional: true }, // optional = degraded
  },
  facts: () => ({ users: userCount }), // counts and modes, never state
});
```

**Express** - same options, mounted as a handler:

```ts
import { nodeHealth } from '@agentage/observability/health';

app.get('/health', nodeHealth({ checks: { db: () => pool.query('SELECT 1') } }));
```

Mount it on `/api/health` too where your edge only routes `/api`, and register it **before**
any rate limiter. For images with no Node process (nginx, a built SPA), generate the payload
at build time with `staticHealth()` and serve it from an exact-match location declared
_before_ any SPA fallback - otherwise every path answers 200 and the probe proves nothing.

### Logs

```ts
import { logger } from '@agentage/observability';

const log = logger(); // service name comes from OTEL_SERVICE_NAME
log.info({ route: '/login' }, 'user signed in');

try {
  await risky();
} catch (err) {
  log.error(err); // structured log + the request's trace flagged red, one call
}
```

`log.error(err)` and `log.fatal(err)` record the exception on the active trace span and
mark it failed - there is no separate capture call to learn. Pass context alongside the
error as `log.error({ err, userId })`; the message defaults to the error's. Stdio MCP
servers must pass `stream: 'stderr'` - on stdio, stdout is the JSON-RPC channel.

### Error events

One error line, one shape, whatever the runtime: `err`, `route` (templated), `method`,
`status`, `user_id`, `error_code`, `fingerprint`, `source`. Set `err.fingerprint` to
override how the errors page groups it.

```ts
import { errorMiddleware } from '@agentage/observability'; // Express: mount last
app.use(errorMiddleware(log));

export const onRequestError = onRequestErrorHook(log); // Next instrumentation.ts
// import { onRequestError as onRequestErrorHook } from '@agentage/observability/next';

server.tool('memory__search', wrapToolHandler(log, 'memory__search', handler)); // MCP
```

`wrapToolHandler` also catches `isError` results, which travel over HTTP 200, and logs the
tool arguments with credential-looking keys redacted and long values truncated.

### Traces

Preload the bootstrap in your Dockerfile `CMD` (or `NODE_OPTIONS`):

```
node --import @agentage/observability/bootstrap dist/index.js
```

`--import`, never `--require`: a CJS preload cannot patch `import`ed modules, so your
Express and HTTP spans silently vanish. **Next.js apps** skip the preload entirely - add
`@vercel/otel` and a one-line `src/instrumentation.ts`:

```ts
export { register } from '@agentage/observability/next';
```

Then set `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_ENDPOINT` (see
[Configuration](#configuration)). Without both, the SDK is never even imported and the
process behaves exactly like an uninstrumented one - logging still works.

## The /health envelope

Every service answers the same shape, so one probe reads your whole estate:

```jsonc
{
  "success": true, // false only on a real outage, paired with 503
  "data": {
    "status": "ok", // ok | degraded | unavailable
    "service": "memory-mcp", // defaults to OTEL_SERVICE_NAME
    "instance": "b82fc8d3", // random per process - never the hostname
    "version": "21150d69...", // COMMIT_SHA, or "0.0.0-dev"
    "commit": "21150d6",
    "buildTime": "2026-08-09T10:08:07Z", // ISO or null, never ""
    "startedAt": "2026-08-09T10:09:50.122Z",
    "uptimeSeconds": 590,
    "checkedAt": "2026-08-10T01:04:40.586Z", // when THIS payload was computed
    "durationMs": 22.7, // total server-side cost
    "checks": { "store": "ok" }, // ok | degraded | down | skipped
    "timings": { "store": 21.5, "facts": 1.1 },
    "reasons": { "search": "timed out after 60ms" }, // only when a check is not ok
    "facts": { "memories": 412 }, // counts and modes only, never state
  },
}
```

`status` is the worst check: any `down` makes it `unavailable` (HTTP 503), any `degraded`
keeps it at 200. A dependency the service survives without must report `degraded`, not
`down`. `data` is always present, including on a 503, so a probe reads a stated outage
instead of an empty body.

**`checks` vs `facts` is the distinction people get wrong.** A check is state you actually
determined. A fact is a count or a mode. If the value can read healthy while the thing is
broken, it is a fact - `authMode: 'oauth'` belongs in `facts`.

### Reading the timing fields

A status word cannot be interrogated. These four can:

| Question                        | Field            | Reading                                                                                                                               |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Is this response cached?        | `checkedAt`      | Frozen across two probes means something in front is serving a copy - a CDN, a proxy, a lost `force-dynamic`.                         |
| Did the check measure anything? | `timings.<name>` | Near `0` is a memoized value; milliseconds is a real round trip. **A memoized check reports `ok` forever after the dependency dies.** |
| Service, or network?            | `durationMs`     | Subtract it from your round trip; the rest is TLS, the edge and the wire.                                                             |
| Why did two probes differ?      | `instance`       | A changed value means a **different replica** answered - not a cache, not a restart.                                                  |

`instance` is random per process and never the hostname: `/health` is public and must not
leak internal topology. Behind a load balancer it is the only thing separating "two
replicas" from "a crash loop" - `uptimeSeconds` looks identical either way.

The same numbers also go out as a `Server-Timing` header
(`health;dur=22.7, store;dur=21.5`), so the split shows in browser devtools and proxy logs
without parsing the body.

### Rules worth following

- **Bound the facts producer, not just the checks.** It is the one people forget: an
  unbounded count off a wedged database outlives your container `HEALTHCHECK --timeout`,
  and the orchestrator kills a task that was only ever slow to count rows. `factsTimeoutMs`
  defaults to 1s.
- **Liveness is not readiness.** If a dependency check can return 503, do not assert
  `response.ok` in your container `HEALTHCHECK`, or the orchestrator restart-loops your
  container over an outage that restarting cannot fix.
- Never put `/health` behind auth, a redirect, or a rate limiter.
- Verify the path is actually reachable through your edge after routing. A route the proxy
  never forwards is decorative.

## API

| Import                              | Export                                                               | Purpose                                              |
| ----------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `@agentage/observability/health`    | `health(options?)`                                                   | Fetch-native handler: Next, Hono, Workers, Deno, Bun |
|                                     | `nodeHealth(options?)`                                               | Express/Connect handler                              |
|                                     | `staticHealth(options?)`                                             | Build-time JSON for images with no process           |
|                                     | `healthEnvelope`, `resolveHealth`, `runChecks`, `serverTimingHeader` | Lower-level pieces if you build your own transport   |
| `@agentage/observability`           | `logger(options?)`                                                   | pino preset: trace-linked lines, `log.error` capture |
|                                     | `withSpan(name, fn, attrs?)`                                         | Add depth deliberately; no-op without an SDK         |
|                                     | `setMcpTool`, `markSpanError`, `setSpanAttributes`                   | MCP tool-call span semantics                         |
|                                     | `errorMiddleware(log, options?)`                                     | Express error handler emitting the `ErrorEvent`      |
|                                     | `onRequestError(log)`                                                | Next `instrumentation.ts` error hook                 |
|                                     | `wrapToolHandler(log, tool, handler)`                                | MCP tool errors, including `isError` results         |
| `@agentage/observability/bootstrap` | (side effect)                                                        | `node --import` trace bootstrap                      |
| `@agentage/observability/next`      | `register`, `onRequestError`                                         | Next.js `instrumentation.ts`                         |

`createHealthHandler`, `healthResponse` and `staticHealthJson` are the previous names for
`nodeHealth`, `health` and `staticHealth`; `createLogger` is the previous name for `logger`,
and `captureError(log, err)` is what `log.error(err)` now does by itself. All remain
exported and unchanged. `checks` also accepts the original
`[{ name, run, timeoutMs, optional }]` array form.

## Configuration

Standard `OTEL_*` env, read by the SDK itself:

| Variable                                       | Notes                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                  | Base URL; the exporter appends `/v1/traces`. Unset = tracing off.                    |
| `OTEL_SERVICE_NAME`                            | Required to start tracing; also the default `service` in `/health`.                  |
| `OTEL_EXPORTER_OTLP_HEADERS`                   | `Authorization=Bearer%20<token>` - percent-encoded (`,` and `=` inside a token too). |
| `OTEL_RESOURCE_ATTRIBUTES`                     | `deployment.environment`, `service.namespace`.                                       |
| `OTEL_TRACES_SAMPLER[_ARG]`                    | `parentbased_traceidratio` + a ratio matched to service volume.                      |
| `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` | `none` where host agents own those signals.                                          |
| `OTEL_SDK_DISABLED`                            | `true` = hard off even when configured.                                              |
| `OTEL_LOG_LEVEL`                               | Unset = silent. `debug` to diagnose a missing-trace report.                          |
| `COMMIT_SHA` / `BUILD_TIME`                    | Image build args, surfaced as `version`/`commit`/`buildTime`.                        |
| `LOG_LEVEL`                                    | pino level for `createLogger` (default `info`).                                      |

`COMMIT_SHA` and `BUILD_TIME` must be redeclared as `ARG` **and promoted to `ENV` in the
runner stage** - ARGs do not cross Docker stage boundaries, and without that your endpoint
reports `0.0.0-dev` forever.

A container health check needs no curl or wget, since node is already in the image:

```
NODE_OPTIONS= node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

Use `127.0.0.1`, not `localhost`: an IPv6 resolution against an IPv4-only listener is a
recurring way to fail a healthy container.

## What gets traced (minimal by design)

Node services emit exactly one SERVER span per request (`{method} {route}`, status code,
duration; scanner probes on unmatched routes collapse to `{method} (unmatched)`; health
probes are never recorded) plus CLIENT spans for outbound http/fetch calls, which carry W3C
propagation to the next service. No Express layer spans, no fs/dns/db auto-spans. Next apps
mirror this through the `/next` entry (noise sampler + span-name normalizer).

Depth is intentional, not automatic:

```ts
import { withSpan } from '@agentage/observability';

await withSpan('store.read', () => store.read(id), { memory: id });
```

`bootstrap.js` calls `module.register()` with `@opentelemetry/instrumentation/hook.mjs` -
the supported replacement for the deprecated `--experimental-loader` flag, and the only way
to patch pure-ESM imports. fs/net/dns auto-instrumentation is deliberately disabled: it
buries request traces under noise.

## Develop

```bash
npm install
npm test           # vitest
npm run verify     # type-check + lint + format:check + test + build + dist smoke
```

`test/edge-safety.test.ts` scans the raw source of the health module - comments included -
for Node-only APIs and imports. The health module must stay dependency-free and Web-API-only:
bundlers detect Node APIs in edge bundles **statically**, so a `typeof` guard does not save
you, and a single slip breaks every app that imports the module through a shared barrel.

## Release

A `chore(release): X.Y.Z` squash-merge subject on `master` publishes to npm via GitHub
Actions; the workflow skips any version already published. Changes: [CHANGELOG.md](./CHANGELOG.md).

## License

MIT - see [LICENSE](./LICENSE).
