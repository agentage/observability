# @agentage/observability

One `/health` endpoint, one log shape, one trace pipeline - for every Node service you run.

Install it, add three lines, and every service answers the same health envelope, writes
logs that link to their traces, and reports errors once instead of twice. Health works on
its own with **zero configuration**; tracing stays completely inert until you point it at a
collector.

## The API (v1)

Four names. `log` what happened, `span` what took time, `setUser` who it was for, `health`
what the service reports about itself.

```ts
import { log, span, setUser, health } from '@agentage/observability';

log.info({ route: '/login' }, 'user signed in'); // JSON to stderr, trace ids attached
await span('store.read', () => store.read(id), { memory: id }); // one properly parented span
setUser(session.user.id); // rides the request: log line, error events, active span
export const GET = health(); // also at @agentage/observability/health
```

`log` is the logger - no construction call, service from `OTEL_SERVICE_NAME`, level from
`LOG_LEVEL`, always stderr (stdout is the JSON-RPC channel of a stdio MCP server).
`log.error(err)` records the exception on the active span and marks it failed.

## Wired for you (Express)

An Express service that preloads the bootstrap gets the whole lane with **no code at all**:

```
node --import @agentage/observability/bootstrap dist/index.js
```

At `app.listen()` the kit mounts, around the routes the service already registered:

- the **request log**, first in the stack, so 404s and rejections are counted too;
- **GET `/health`** and **GET `/api/health`** liveness - unless the service answers those
  paths itself, in which case its own route wins (readiness stays `health({ checks })`);
- the **browser-error collector** on POST `/api/client-errors` when
  `OTEL_CLIENT_ERROR_ORIGINS` is set, text/plain body and all;
- the **error middleware**, last, so a thrown error becomes one `ErrorEvent` and the
  standard envelope.

The bootstrap also enriches the global `fetch` with the call site and target of a failed
outbound call, and logs an `uncaughtException`/`unhandledRejection` as `fatal` before the
process dies. Each piece has an off switch (see [Configuration](#configuration)), and
mounting is idempotent - a service that wires a piece by hand keeps its own.

## Wired for you (MCP tools)

An MCP server that preloads the bootstrap gets per-tool observability with **no code at
all**, whether it speaks HTTP or stdio: every tool registered through `McpServer`
(`registerTool`/`tool`) or a low-level `Server`'s `tools/call` handler is wrapped exactly
once, and each call gets a span named after the tool (the HTTP root span is renamed at
export; a stdio server's call becomes the root itself), `mcp.tool.args` with content-bearing
fields reduced to a `<N chars>` marker and credential-looking keys redacted, `mcp.results.count`
and `mcp.response.bytes` on the way out, an `ErrorEvent` when the handler throws, and one
`kind:'tool'` wide-event line per call with `tool`, `duration_ms`, `status`, `user_id` and
`user_type`. An `isError` result marks the span failed but raises no `ErrorEvent` - those are
usually expected refusals - unless `OBS_MCP_CAPTURE_ISERROR=on`. For a stdio server, the
whole wiring is the shebang:

```
#!/usr/bin/env -S node --import @agentage/observability/bootstrap
```

> Everything below this line still works and still ships, but it is **deprecated and
> removed in 1.0 final**: `createLogger`, `createRequestLog`, `errorMiddleware`,
> `onRequestError`, `collectorHandler`, `wrapToolHandler`, `setMcpTool`, `markSpanError`,
> `setSpanAttributes`, `tracedFetch`, `withSpan` (renamed to `span`), `classifyClientType`,
> `CLIENT_TYPE_HEADER`, `USER_TYPE_FIELD`, `UserType`.

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
import { createHealthHandler } from '@agentage/observability/health';

app.get('/health', createHealthHandler({ checks: { db: () => pool.query('SELECT 1') } }));
```

Mount it on `/api/health` too where your edge only routes `/api`, and register it **before**
any rate limiter.

### Logs

```ts
import { log } from '@agentage/observability';

log.info({ route: '/login' }, 'user signed in');

try {
  await risky();
} catch (err) {
  log.error(err); // structured log + the request's trace flagged red, one call
}
```

`log.error(err)` and `log.fatal(err)` record the exception on the active trace span and
mark it failed - there is no separate capture call to learn. Pass context alongside the
error as `log.error({ err, userId })`; the message defaults to the error's. Every line goes
to stderr, so a stdio MCP server needs no option to keep stdout clean for JSON-RPC.
(`createLogger(options?)` is deprecated: use `log`.)

### Request logs

```ts
import { createRequestLog, log } from '@agentage/observability';

app.use(createRequestLog(log)); // before the routers, so 404s are counted too
```

One line per finished request: `kind: 'http'`, `method`, `path`, `route` (templated),
`status`, `duration_ms`, `user_id`, plus `trace_id`/`span_id` from the logger mixin. Health
probes (`/health`, `/api/health`, `/status`, `/hc`) emit no line - the same paths the tracer
drops, so both lanes agree on what a probe is. Pass `skipHealthProbes: false` where a probe
line is a real record, such as a deploy that commit-asserts on `/api/health` reaching the
service through the edge.

`route` is the grouping key, so it stays bounded: a matched route gives its template, a
route matched by RegExp (a whole app mounted behind one pattern) falls back to a
low-cardinality template derived from the URL, and a request no router claimed (404s,
rejections before the router) gets the literal `(unmatched)` - the spelling the span lane
already uses for an unmatched server span - one key for all of it, instead
of one per URL a scanner invents. The concrete target stays on `path`, capped at 200
characters with a trailing `...` when nothing matched. Pass `userId` when the user does not
live at `req.user.id`.

`user_type` classifies the traffic (`user` / `test` / `service` / `bot`) - test and service
callers declare themselves, they are not guessed. The rules run in one fixed order, the
same order the edge VRL and the web `packages/shared` copy use:

| #   | Rule                                                                 | Verdict   |
| --- | -------------------------------------------------------------------- | --------- |
| 1   | `x-client-type: service`                                             | `service` |
| 2   | `x-client-type: test`, or a playwright/headlesschrome/puppeteer UA   | `test`    |
| 3   | `x-client-type: bot`, a bot UA, a scanner path, or an IP in a range  | `bot`     |
| 4   | Empty UA, or a machine-client UA (`node`, `axios`, `go-http-client`) | `service` |
| 5   | Anything else                                                        | `user`    |

Rule 4 is why an SSR fetch that sets no headers is not counted as a visitor. Rule 3's IP
ranges are caller-supplied, since the addresses change: pass `botIpRanges` (IPv4 CIDRs, a
bare address means `/32`) or set `OTEL_BOT_IP_RANGES`, and a fleet crawling behind
plain-Chrome user agents is classified from where it calls rather than what it claims. The
address comes from the leftmost `x-forwarded-for` hop.

The middleware also puts the value on the request's span as the `user_type` attribute and
into OTel baggage, so the admin console can drop test traffic from spans without regexing
the user agent. Every span `withSpan` creates and every span `setMcpTool` stamps inherits
it. Pass your own `classify` to override the rule, or `() => undefined` to drop the field;
`classifyClientType(input)` is the same verdict as a plain function.

### Error events

One error line, one shape, whatever the runtime: `err`, `route` (templated), `method`,
`status`, `user_id`, `error_code`, `fingerprint`, `source`, plus `cause`, `frame`,
`target` and `category`. Set `err.fingerprint` to override how the errors page groups it.

`cause` is the deepest `.cause` in the chain (capped at 5, cycle-safe) summarized as
`Error: getaddrinfo ENOTFOUND agentage-web_backend`, and its system `code` becomes
`error_code` when the error carries no application code of its own. `frame` is the top
in-app stack frame, `src/provision.ts:42:11 in provisionMemory` - node_modules, `node:`,
`internal/`, webpack-internal and native frames are skipped. Every emitter gets both.

`category` classifies the root cause into `timeout`, `connectivity`, `db` (a SQLSTATE
like `23505`) or `logic`, the first split on an error dashboard: is it them, or is it us.
It is always present. `target` names what an outbound call was reaching for,
`POST api.test:8443/v1/memories/:id` - method, host with port, templated path, no query
and no credentials. It is set by the patched global `fetch` and found through any
wrapping cause.

The Express handler answers one envelope, and the trace id is on the response twice - in
the body and as the `X-Trace-Id` header, so a failed call can be looked up from a browser's
network tab:

```jsonc
{
  "success": false,
  "error": { "code": "ENOTFOUND", "message": "fetch failed" },
  "traceId": "a3ce...",
}
```

`code` is the same one the error line groups on: an application `code` wins, and a bare
error name loses to the root cause's system code. A 4xx answers the envelope without
emitting an `ErrorEvent` - a refused request is the API working - so pass
`captureBelow500: true` where those are worth a line.

```ts
import { errorMiddleware } from '@agentage/observability'; // Express: mount last
app.use(errorMiddleware(log)); // the bootstrap does this for you

export const onRequestError = onRequestErrorHook(log); // Next instrumentation.ts
// import { onRequestError as onRequestErrorHook } from '@agentage/observability/next';

server.tool('memory__search', wrapToolHandler(log, 'memory__search', handler)); // MCP
```

`wrapToolHandler` also catches `isError` results, which travel over HTTP 200, and logs the
tool arguments with credential-looking keys redacted and long values truncated.

An outbound `fetch` that fails rejects with a bare `TypeError: fetch failed` whose stack
holds no application frame and never says which call failed. The bootstrap wraps the global
`fetch` so every outbound call attaches its call site and its target to the rejection -
`frame` then points at your code and `target` names the endpoint, with nothing to import:

```ts
const res = await fetch(`${backend}/api/memories`, { headers });
```

(`tracedFetch` is now plain `fetch` and deprecated; `OBS_FETCH_PATCH=off` disables the wrap.)

#### From the browser

`@agentage/observability/browser` is dependency-free and tiny - it pulls in no pino, no
OpenTelemetry, and does nothing outside a browser. It hooks `window.onerror`,
`unhandledrejection` and `console.error`, then batches over `sendBeacon`:

```ts
import { installErrorReporter } from '@agentage/observability/browser';
installErrorReporter({ endpoint: '/api/client-errors', service: 'web', userId: user?.id });

// The bootstrap mounts exactly this when OTEL_CLIENT_ERROR_ORIGINS is set.
app.post(
  '/api/client-errors',
  express.text({ type: '*/*' }),
  collectorHandler(log, {
    allowOrigins: ['https://app.agentage.io'], // 403 for anything else, 413 over 64KB
  })
);
```

The reporter rate-limits itself (20 events/minute by default), drops identical consecutive
messages, and never throws. The collector whitelists the payload - unknown keys never reach
your logs - and re-emits each event as the same error line with `source: 'client'` and the
reporting app's `service`. `sendBeacon` posts `text/plain`, so parse the body as text (or
`express.json({ type: '*/*' })`).

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

HTTP, Express and fetch spans come out of the box. Datastore and queue spans are **optional
peers** - install the ones your service actually uses and the bootstrap picks them up:

```bash
npm install @opentelemetry/instrumentation-pg        # also -mongodb, -redis, -amqplib
```

Not installed means not traced, silently: no warning, no failed boot.

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

| Import                              | Export                                             | Purpose                                              |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `@agentage/observability/health`    | `health(options?)`                                 | Fetch-native handler: Next, Hono, Workers, Deno, Bun |
|                                     | `createHealthHandler(options?)`                    | Express/Connect handler                              |
|                                     | `healthResponse(options?)`                         | Next route-handler body returning a `Response`       |
|                                     | `healthEnvelope(service?, options?)`               | The envelope itself, if you build your own transport |
| `@agentage/observability`           | `log`                                              | The logger: JSON to stderr, trace-linked lines       |
|                                     | `span(name, fn, attrs?)`                           | Add depth deliberately; no-op without an SDK         |
|                                     | `setUser(id)`                                      | Who the request is for; rides the OTel context       |
|                                     | `health(options?)`                                 | Re-exported for Node, same handler as `/health`      |
|                                     | _deprecated below - removed in 1.0 final_          |                                                      |
|                                     | `createLogger(options?)`                           | pino preset: trace-linked lines, `log.error` capture |
|                                     | `withSpan(name, fn, attrs?)`                       | Renamed to `span`                                    |
|                                     | `setMcpTool`, `markSpanError`, `setSpanAttributes` | MCP tool-call span semantics                         |
|                                     | `createRequestLog(log, options?)`                  | Express middleware: one wide event per request       |
|                                     | `classifyClientType(input)`                        | `user`/`test`/`service`/`bot` from header, UA, path  |
|                                     | `errorMiddleware(log, options?)`                   | Express error handler emitting the `ErrorEvent`      |
|                                     | `onRequestError(log)`                              | Next `instrumentation.ts` error hook                 |
|                                     | `wrapToolHandler(log, tool, handler)`              | MCP tool errors, including `isError` results         |
|                                     | `tracedFetch(input, init?)`                        | Plain `fetch`; the bootstrap enriches the global one |
|                                     | `collectorHandler(log, options)`                   | Sink for the browser reporter's events               |
| `@agentage/observability/bootstrap` | (side effect)                                      | `node --import` trace bootstrap                      |
| `@agentage/observability/next`      | `register`, `onRequestError`                       | Next.js `instrumentation.ts`                         |

`log.error(err)` is what the removed `captureError(log, err)` did: the logger lifts `cause`,
`frame`, `target`, `category` and `error_code` onto the line by itself. The `logger` /
`nodeHealth` / `staticHealth` aliases and the standalone lifters were removed in v1.
`checks` also accepts the original `[{ name, run, timeoutMs, optional }]` array form.

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
| `OTEL_BOT_IP_RANGES`                           | Comma-separated IPv4 CIDRs classified as `bot`. Unset = no IP rule.                  |
| `OTEL_CLIENT_ERROR_ORIGINS`                    | Comma-separated origins allowed to POST client errors. Unset = no collector.         |

What the bootstrap wires, and how to turn a piece off. Each takes the literal `off`:

| Variable            | Off means                                                              |
| ------------------- | ---------------------------------------------------------------------- |
| `OBS_REQUEST_LOG`   | No request log line; mount `createRequestLog(log)` yourself.           |
| `OBS_ERROR_MW`      | No error middleware, so errors reach Express's default handler.        |
| `OBS_AUTO_HEALTH`   | No auto-mounted `/health` + `/api/health`.                             |
| `OBS_COLLECTOR`     | No `/api/client-errors`, even with origins configured.                 |
| `OBS_FETCH_PATCH`   | The global `fetch` is left alone (no call site or target on failures). |
| `OBS_CRASH_CAPTURE` | No `uncaughtException`/`unhandledRejection` line; Node's default only. |
| `OBS_MCP_PATCH`     | MCP tools are not instrumented; wrap handlers yourself.                |

One more, and it takes the literal `on`: `OBS_MCP_CAPTURE_ISERROR` also raises an
`ErrorEvent` for a tool answering `isError` (span + wide event report it either way).

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
duration; scanner probes on unmatched routes collapse to `{method} (unmatched)`) plus CLIENT
spans for outbound http/fetch calls, which carry W3C propagation to the next service. No
Express layer spans, no fs/dns auto-spans, and datastore spans only for the optional
instrumentation peers you installed. Next apps mirror this through the `/next`
entry (noise sampler + span-name normalizer).

Health probes (`/health`, `/api/health`, `/status`, `/hc`) are recorded in neither
direction: not the inbound probe, and not an outbound call TO one. A page polling a
service's `/health` every few seconds emits hundreds of client spans an hour and no signal,
since the probe's answer belongs in that page's state. Record one deliberately with
`withSpan` where a specific probe is worth a trace.

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

A version bump to `package.json` on `master` publishes to npm via GitHub Actions; the
workflow skips any version already published, so any other change to the file is a no-op.
The Friday release train cuts the bump itself (minor by default, `major` on manual
dispatch). Changes: [CHANGELOG.md](./CHANGELOG.md).

## License

MIT - see [LICENSE](./LICENSE).
