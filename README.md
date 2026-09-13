# @agentage/observability

One `/health` endpoint, one log shape, one trace pipeline - for every Node service you run.
Preload it and an Express or MCP service reports itself with **no code at all**: request log,
health, error envelope, per-tool spans. `health` works on its own with zero configuration, and
tracing stays completely inert until you point it at a collector.

## Setup

```bash
npm install @agentage/observability
```

| Runtime            | Wiring                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Express / Node     | `node --import @agentage/observability/bootstrap dist/index.js` (Dockerfile `CMD`, or `NODE_OPTIONS`)   |
| stdio MCP server   | `#!/usr/bin/env -S node --import @agentage/observability/bootstrap`                                     |
| Next.js            | `src/instrumentation.ts`: `export { register } from '@agentage/observability/next';` (+ `@vercel/otel`) |
| React / browser    | `<ErrorReporter endpoint="/api/client-errors" service="web" userId={user?.id} />` from `/react`         |
| Workers, Deno, Bun | `export const GET = health();` from `/health` - zero dependencies, no Node APIs, edge-safe              |

`--import`, never `--require`: a CJS preload cannot patch `import`ed modules, so your Express and
HTTP spans silently vanish. `@opentelemetry/api` is a **peer** - install it alongside, since two
copies in one tree put spans on the wrong provider.

## The API

Four names over six entries - root, `/bootstrap`, `/next`, `/browser`, `/react`, `/health`.

```ts
import { log, span, setUser, health } from '@agentage/observability';

log.info({ route: '/login' }, 'user signed in'); // JSON to stderr, trace ids attached
log.error(err); // + records the exception on the active span and marks it failed

await span('store.read', () => store.read(id), { memory: id }); // one properly parented span
setUser(session.user.id); // after auth, once

export const GET = health({
  checks: { db: () => pool.query('SELECT 1') }, // throws, rejects, hangs or false = down
  facts: () => ({ memories: count }), // counts and modes, never state
});
```

`log` needs no construction call: `service` from `OTEL_SERVICE_NAME`, level from `LOG_LEVEL`,
always stderr (stdout is the JSON-RPC channel of a stdio MCP server). `span` is where trace depth
comes from - the auto-instrumentation stays at one span per request - and is inert without a
started SDK, so library code can call it unconditionally. `setUser` rides the OTel context onto the
request log line, every error raised under it and the active span, inside a scope the kit opened
(the request log, or `span()`) - and it works with tracing unconfigured too, so a no-collector
deploy keeps its `user_id`. Zero-config `health()` is a valid **liveness** probe; add `checks` and
the same factory is your **readiness** probe. Pick the form by runtime, not by age: `health()`
returns a fetch-native handler (Next route handlers, Hono, Workers, Deno, Bun), **`createHealthHandler()`
is the Express one** (`app.get('/health', createHealthHandler({ checks }))`) and neither is
deprecated; `healthResponse`/`healthEnvelope` are the raw `Response`/object. Never put it behind
auth, a redirect or a rate limiter. In the browser, `getTraceId()` from `/browser` (also
`document.documentElement.dataset.obsTrace`) is the id an error screen shows a user for support.

## What you get automatically

**One wide event per finished request**, emitted at the front of the stack so 404s and rejections
are counted too. Probe paths (`/health`, `/api/health`, `/status`, `/hc`) emit none.

<!-- prettier-ignore -->
```jsonc
{ "kind": "http", "method": "GET", "path": "/api/memories/m1", "route": "/api/memories/:id",
  "status": 200, "duration_ms": 12, "user_id": "u_1", "user_type": "user",
  "trace_id": "a3ce...", "span_id": "9f21...", "service": "memory-mcp", "msg": "request" }
```

`route` is the grouping key and stays bounded: the matched template, a template derived from the
URL for a RegExp-mounted router, or the literal `(unmatched)`. `path` is the concrete target,
capped at 200 characters. `user_type` is `user` / `test` / `service` / `bot` - test and service
callers declare themselves via `x-client-type`, bots come from the UA, a scanner path or an IP in
`OTEL_BOT_IP_RANGES`, and an empty or machine-client UA is `service`, which is why an SSR fetch is
not counted as a visitor. It lands on the span and in baggage too.

**One event per MCP tool call**, for both `McpServer` (`registerTool`/`tool`) and a low-level
`Server`'s `tools/call` handler, over HTTP or stdio, each call wrapped exactly once:

<!-- prettier-ignore -->
```jsonc
{ "kind": "tool", "tool": "memory__search", "duration_ms": 34, "status": "ok",
  "user_id": "u_1", "user_type": "user", "msg": "tool_call" }
```

Its span carries `mcp.tool.args` (content-bearing fields reduced to a `<N chars>` marker,
credential-looking keys redacted), `mcp.results.count` and `mcp.response.bytes`. An `isError`
result marks the span failed and sets `status: "error"` but raises **no** error event - those are
usually expected refusals - unless `OBS_MCP_CAPTURE_ISERROR=on`.

**One error line, one shape**, whatever the runtime - HTTP handler, Next render, tool call,
browser, or an uncaught crash (logged `fatal` before the process dies):

<!-- prettier-ignore -->
```jsonc
{ "err": { "type": "TypeError", "message": "fetch failed", "stack": "..." },
  "route": "/api/memories/:id", "method": "POST", "status": 500, "user_id": "u_1",
  "error_code": "ENOTFOUND", "cause": "Error: getaddrinfo ENOTFOUND agentage-web_backend",
  "frame": "src/provision.ts:42:11 in provisionMemory", "category": "connectivity",
  "target": "POST api.test:8443/v1/memories/:id", "fingerprint": "...", "source": "server" }
```

`cause` is the deepest `.cause` (capped at 5, cycle-safe) and its system `code` becomes
`error_code` when the error carries none of its own. `frame` is the top in-app frame -
node_modules, `node:`, `internal/`, webpack-internal and native frames are skipped. `category` is
`timeout` / `connectivity` / `db` (a SQLSTATE) / `logic`, always present. `target` names what an
outbound call was reaching for; the patched global `fetch` attaches it, which is also what gives a
bare `TypeError: fetch failed` an application `frame`. `source` is `server` / `client` / `tool`,
and `err.fingerprint` overrides grouping. An Express error also answers one envelope, with the
trace id in the body and as the `X-Trace-Id` header; a 4xx answers it without emitting a line.

<!-- prettier-ignore -->
```jsonc
{ "success": false, "error": { "code": "ENOTFOUND", "message": "Internal server error" }, "traceId": "a3ce..." }
```

**A 5xx answers `Internal server error`, never the thrown message** - a driver, git or fetch
message is internal detail, and a browser is the wrong place to read it. The `code` is kept, the
logged line above keeps the full message and stack, and `traceId` is the handle that ties the
user's report to it. A 4xx keeps its real message (a client error is the client's to fix). Throw
with `expose: true` for a 5xx message you wrote for the caller, pass `maskServerErrors: false` to
opt a handler out, or set `OBS_MASK_5XX=off` for the auto-wired one.

**The `/health` envelope**, the same shape from every service:

```jsonc
{
  "success": true, // false only on a real outage, paired with 503
  "data": {
    "status": "ok", // ok | degraded | unavailable - the worst check wins
    "service": "memory-mcp", // defaults to OTEL_SERVICE_NAME
    "instance": "b82fc8d3", // random per process - never the hostname
    "version": "21150d69...",
    "commit": "21150d6", // COMMIT_SHA, or "0.0.0-dev" / "dev"
    "buildTime": "2026-08-09T10:08:07Z", // ISO or null, never ""
    "startedAt": "2026-08-09T10:09:50.122Z",
    "uptimeSeconds": 590,
    "checkedAt": "2026-08-10T01:04:40.586Z", // when THIS payload was computed
    "durationMs": 22.7, // total server-side cost
    "checks": { "store": "ok" }, // ok | degraded | down | skipped
    "timings": { "store": 21.5, "facts": 1.1 }, // a check near 0 is memoized, not measured
    "reasons": { "search": "timed out after 60ms" }, // only when a check is not ok
    "facts": { "memories": 412 }, // counts and modes only, never state
  },
}
```

Any `down` makes `status` `unavailable` (HTTP 503); a dependency the service survives without
must report `degraded`. **A check is state you determined, a fact is a count or a mode** - if the
value can read healthy while the thing is broken, it is a fact. `data` is present even on a 503. A
changed `instance` across two probes means a different replica answered, not a cache; a frozen
`checkedAt` means something in front is serving a copy. The same numbers go out as
`Server-Timing: health;dur=22.7, store;dur=21.5`. Checks and the facts producer are both bounded
(1s default), because an unbounded count off a wedged database outlives the container
`HEALTHCHECK --timeout` and gets a merely-slow task killed.

**Span names**, minimal by design: exactly one SERVER span per request, `{method} {route}` -
`{method} (unmatched)` for scanner probes - plus CLIENT spans for outbound http/fetch calls, which
carry W3C propagation onward. A `fetch GET https://host/x?y=1` client span is renamed `{method}
{route}` so one facet combination is not its own operation; on a matched route `http.route` and
`url.path` are replaced by the template (the concrete path is customer data) and `url.full` is
dropped; an MCP root span takes the bare tool name; Next's `RSC ` prefix becomes `next.rsc=true`.
No Express layer spans, no fs/dns/net auto-spans, health probes recorded in neither direction.
Datastore and queue spans need the matching optional peer installed
(`@opentelemetry/instrumentation-pg`, `-mongodb`, `-redis`, `-amqplib`); not installed means not
traced, silently.

**Auto-mounted routes**, only where the service does not answer them itself: `GET /health` and
`GET /api/health` (liveness), plus `POST /api/client-errors` when `OTEL_CLIENT_ERROR_ORIGINS` is
set. The browser reporter posts `text/plain` over `sendBeacon`, rate-limits itself (20
events/minute), never throws, and mints one W3C trace id per user action that it sends as a
`traceparent` header on same-origin `fetch` calls - so the click, the requests it fired and the
error line that came back share one id, and its sampled flag keeps a real user action traced in
full where the service samples at a ratio. Cross-origin requests are never touched.

`COMMIT_SHA` and `BUILD_TIME` must be redeclared as `ARG` **and promoted to `ENV` in the runner
stage** - ARGs do not cross Docker stage boundaries, and without that `/health` reports
`0.0.0-dev` forever. A container health check needs no curl, since node is in the image:

```
NODE_OPTIONS= node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

Use `127.0.0.1`, not `localhost`: an IPv6 resolution against an IPv4-only listener is a recurring
way to fail a healthy container. And where a check can answer 503, do not assert `response.ok`
there, or the orchestrator restart-loops over an outage that restarting cannot fix.

## Configuration

Standard `OTEL_*`, read by the tracer and the exporter:

| Variable                             | Notes                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | Base URL; the exporter appends `/v1/traces`. Unset = tracing off.                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Signal-specific override; wins over the base URL.                                    |
| `OTEL_SERVICE_NAME`                  | Required to start tracing; the default `service` in `/health` and on every log line. |
| `OTEL_EXPORTER_OTLP_HEADERS`         | `Authorization=Bearer%20<token>` - percent-encoded (`,` and `=` inside a token too). |
| `OTEL_RESOURCE_ATTRIBUTES`           | `deployment.environment`, `service.namespace`.                                       |
| `OTEL_TRACES_SAMPLER[_ARG]`          | `parentbased_traceidratio` + a ratio matched to service volume.                      |
| `OTEL_SDK_DISABLED`                  | `1`/`true`/`yes` = hard off even when configured.                                    |
| `OTEL_LOG_LEVEL`                     | Unset = silent. `debug` to diagnose a missing-trace report.                          |
| `OTEL_BOT_IP_RANGES`                 | Comma-separated IPv4 CIDRs classified as `bot`. Unset = no IP rule.                  |
| `OTEL_CLIENT_ERROR_ORIGINS`          | Comma-separated origins allowed to POST client errors. Unset = no collector.         |
| `LOG_LEVEL`                          | pino level (default `info`).                                                         |
| `COMMIT_SHA` / `BUILD_TIME`          | Image build args, surfaced as `version`/`commit`/`buildTime`.                        |

`OBS_*` are the escape hatches, each taking the literal `off`. Wiring is idempotent: the request
log and the error middleware carry a marker symbol, so a service that mounts either by hand keeps
its own and the auto-wiring skips that piece - one line, one handler, never two.

| Variable                  | Off means                                                                 |
| ------------------------- | ------------------------------------------------------------------------- |
| `OBS_REQUEST_LOG`         | No request log line.                                                      |
| `OBS_ERROR_MW`            | No error middleware, so errors reach Express's default handler.           |
| `OBS_MASK_5XX`            | 5xx answer the thrown message instead of `Internal server error`.         |
| `OBS_AUTO_HEALTH`         | No auto-mounted `/health` + `/api/health`.                                |
| `OBS_COLLECTOR`           | No `/api/client-errors`, even with origins configured.                    |
| `OBS_FETCH_PATCH`         | The global `fetch` is left alone (no call site or target on failures).    |
| `OBS_CRASH_CAPTURE`       | No `uncaughtException`/`unhandledRejection` line; Node's default only.    |
| `OBS_MCP_PATCH`           | MCP tools are not instrumented.                                           |
| `OBS_MCP_CAPTURE_ISERROR` | Takes `on`, not `off`: also raise an error event for an `isError` result. |

## Deprecated (removed in the next major)

Still exported, still working - and every one of them is now automatic.

- `createLogger(options?)` -> `log` · `withSpan` -> `span` · `installErrorReporter` -> `observeBrowser`
- `tracedFetch(input, init?)` -> plain `fetch`; the bootstrap enriches the global one
- `createRequestLog(log)`, `errorMiddleware(log)` -> mounted at `listen()`
- `collectorHandler(log, options)` -> mounted at `listen()` with `OTEL_CLIENT_ERROR_ORIGINS`
- `wrapToolHandler`, `setMcpTool`, `markSpanError`, `setSpanAttributes` -> the MCP patch
- `classifyClientType`, `CLIENT_TYPE_HEADER`, `USER_TYPE_FIELD`, `UserType` -> `user_type` on the request log
- `onRequestError(log)` from the root -> the same name from `/next`, which is not deprecated

## Testing a service that uses the kit

`log` is a lazy Proxy over the real pino logger, so **`vi.spyOn(log, 'error')` silently no-ops** -
the spy is defined on the proxy target while every read goes through the trap to the logger. Assert
on the lines instead, by pointing a logger at your own destination:

```ts
const lines: Record<string, unknown>[] = [];
const log = createLogger({
  service: 'test',
  destination: { write: (s) => lines.push(JSON.parse(s)) },
});
// or, for the singleton: vi.spyOn(process.stderr, 'write') and JSON.parse each chunk
```

## Develop

```bash
npm test       # vitest: test/contract (the shapes above), test/integration, test/unit
npm run verify # type-check + lint + format:check + test + build + dist and bootstrap smokes
```

`test/contract/edge-safety.test.ts` scans the raw source of the health module - comments and all -
for Node-only APIs and imports. That module must stay dependency-free and Web-API-only: bundlers
detect Node APIs in edge bundles **statically**, so a `typeof` guard does not save you, and a
single slip breaks every app importing the module through a shared barrel.

## Release

A version bump to `package.json` on `master` publishes to npm via GitHub Actions; the workflow
skips any version already published, so any other change to the file is a no-op. The Friday
release train cuts the bump itself (minor by default, `major` on manual dispatch).
Changes: [CHANGELOG.md](./CHANGELOG.md).

## License

MIT - see [LICENSE](./LICENSE).
