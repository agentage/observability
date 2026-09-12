# Changelog

## 1.0.0 (unreleased)

- **The API is four names**: `log` (module singleton, service from `OTEL_SERVICE_NAME`, always
  stderr), `span` (renamed from `withSpan`), `setUser`, `health` - over six entries: root,
  `/bootstrap`, `/next`, `/browser`, `/react`, `/health`. Everything else is internal.
- **The bootstrap wires an Express service with zero code.** Preloaded with `node --import`, it
  patches the express Application prototype's `listen` through
  the OTel module hook and mounts, around the routes the service already registered: the request
  log first, `GET /health` + `GET /api/health` liveness, `POST /api/client-errors` when
  `OTEL_CLIENT_ERROR_ORIGINS` is set, the error middleware last. A route the service owns always
  wins, wiring is idempotent, and every piece has an `OBS_*=off` hatch.
- **MCP tools are instrumented automatically** by the same hook (`McpServer.registerTool`/`tool`
  and `Protocol.setRequestHandler` for `tools/call`, HTTP or stdio): a span named after the tool
  with redacted `mcp.tool.args`, `mcp.results.count`/`mcp.response.bytes`, an ErrorEvent on throw,
  and one `kind:'tool'` wide event per call. A hand-rolled `tool-log.ts` in a consumer is
  **deletable**; `OBS_MCP_CAPTURE_ISERROR=on` also raises an event for an `isError` result.
- **The global `fetch` carries the call site and target** of a failed outbound call, and
  `uncaughtException`/`unhandledRejection` are logged `fatal` before the process dies.
- **Browser trace ids**: `observeBrowser` (renamed from `installErrorReporter`) mints one W3C trace
  id per user action and sends it as `traceparent` on same-origin fetches, so a click, its requests
  and the error line share one id; readable via `getTraceId()` / `data-obs-trace`. New `/react`
  entry ships `<ErrorReporter />`. No OpenTelemetry ships to the browser.
- **Error envelope changed** to `{ success, error: { code, message }, traceId }` plus an
  `X-Trace-Id` response header, and a 4xx no longer emits an ErrorEvent by default
  (`captureBelow500: true` restores it).
- **`captureError(log, err)` is gone**: `log.error(err)` does it. The logger lifts `cause`,
  `frame`, `target`, `category` and `error_code` onto the line itself and records the exception on
  the active span. `tracedFetch` -> plain `fetch`. `createLogger` -> `log`. `withSpan` -> `span`.
- **NodeSDK dropped** for an explicit `NodeTracerProvider` + `registerInstrumentations`: a clean
  consumer install goes from 106 packages to 41. `@opentelemetry/api` is now a **peer** (two copies
  put spans on the wrong provider), and `instrumentation-{pg,mongodb,redis,amqplib}` are
  **optional peers a consumer declares itself** - a service using pg or mongodb must install the
  matching package or lose those spans, silently.
- Deprecated re-exports (`createLogger`, `createRequestLog`, `errorMiddleware`, `onRequestError`,
  `collectorHandler`, `wrapToolHandler`, `setMcpTool`, `markSpanError`, `setSpanAttributes`,
  `tracedFetch`, `withSpan`, `classifyClientType`, `installErrorReporter`) all still ship in 1.0
  and are removed in the next major.
- README rewritten around the shapes the estate reads; tests reorganized into `test/contract`,
  `test/integration`, `test/unit`.

## 0.20.0 - 2026-09-07

- `classifyClientType` is back in lockstep with the estate's two other copies (web
  `packages/shared/src/client-type.ts` and the Vector VRL in
  `infrastructure/ansible/roles/log_agent/templates/vector.yaml.j2`). The edge had a
  rule the kit never had: an EMPTY user agent, or a machine-client one (`node`,
  `node-fetch`, `undici`, `axios`, `got`, `python-requests`, `python-urllib`,
  `aiohttp`, `httpx`, `go-http-client`, `curl`, `wget`, `okhttp`, `java`,
  `apache-httpclient`, `libwww`, `guzzlehttp`, `postmanruntime`), classifies as
  `service`. Without it an SSR fetch that sets no headers was logged as a real
  visitor - 1.8M requests a day on one service alone. The rule runs AFTER the bot
  checks, exactly as it does at the edge, so a scanner running curl stays a bot.
- `x-client-type: bot` is now honored, so a tier that has already classified a
  caller can propagate the verdict downstream instead of every hop re-guessing.
  `service` and `test` are unchanged.
- `classifyClientType` accepts `ip` and `botIpRanges` (IPv4 CIDRs, a bare address
  means `/32`), checked with the other bot rules: a crawler fleet behind disguised
  plain-Chrome user agents is classified from where it calls rather than from what
  it claims. No address list is baked into the package - the ranges are config, and
  they change. `createRequestLog` fills `ip` from the leftmost `x-forwarded-for` hop
  and takes ranges from `botIpRanges` or the comma-separated `OTEL_BOT_IP_RANGES`,
  so a service turns the rule on by env alone. `ipInRanges(ip, ranges)` is exported;
  malformed input never throws, it just does not match, and IPv6 never matches.
- Health probes are now dropped OUTBOUND as well as inbound, on both paths: the Node
  tracer ignores client requests to a probe path (`HttpInstrumentation`'s
  `ignoreOutgoingRequestHook`, `UndiciInstrumentation`'s `ignoreRequestHook`) and
  `NextNoiseSampler` NOT_RECORDs client spans whose target is one. A system page
  polling two services emitted ~800 client spans an hour carrying no signal, since a
  probe's answer belongs in the polling app's state. Unconditional, like the inbound
  rule already was; a service that genuinely wants a probe span records it with
  `withSpan`.

## 0.18.0 - 2026-08-28

- `createRequestLog` emits no line for health-probe paths (`/health`, `/api/health`,
  `/status`, `/hc`), reusing the tracer's own `isHealthProbePath` so both lanes agree
  on what a probe is. Probes fire every few seconds per task and carried no signal.
  `skipHealthProbes: false` keeps them, for a service whose deploy commit-asserts on
  a health line rather than on the response.
- The `route` field is bounded: a request no router claimed (404s, rejections before
  the router) now logs the literal `(unmatched)` instead of a template derived from
  the URL, so scanner traffic cannot mint one grouping key per invented URL. That is
  the spelling the span lane already uses for an unmatched server span. Matched
  routes - including the RegExp-mount fallback - are unchanged. The concrete target
  stays on `path`, capped at 200 characters with a trailing `...` when nothing
  matched. Field NAMES are unchanged; only unmatched values are bounded.
  `UNMATCHED_ROUTE` is exported so consumers can filter on it.
- `tracedFetch` builds its call-site stack in the rejection branch instead of before
  every request. V8 async stack traces still reach the awaiting caller, so the
  attached `callSite`/`fetchTarget` shape on failures is unchanged and the success
  path stops paying for a stack nobody reads.

## 0.16.0 - 2026-08-14

- `user_type` is now classified by the kit and lands on SPANS, not just the request
  log line. `classifyClientType({ header, userAgent, path })` mirrors the estate
  rules 1:1 (the `x-client-type` header wins - `service`/`test`; then a
  playwright/headlesschrome/puppeteer UA; then bot UAs and scanner paths; else
  `user`), so test traffic is declared rather than guessed.
- `createRequestLog` uses that classifier by default (an injected `classify` still
  wins, `() => undefined` drops the field), stamps `user_type` on the request span
  and puts it into OTel baggage. `withSpan` and `setMcpTool` stamp every span they
  touch from that context; `stampUserType(span)` and `userTypeFromContext()` are
  exported for spans you create yourself.
- Note: `classify` now runs at request ENTRY instead of at `finish`, so the value
  exists while the request is still running.

## 0.15.1 - 2026-08-14

- `createRequestLog` captures the request identity once at middleware entry
  (`req.originalUrl`, query stripped) instead of reading `req.path` at `finish`.
  Express rewrites `req.path`/`req.baseUrl` to be router-relative once a mounted
  router handles the request, so anything ending inside a router - a guard 401 on
  a router mounted at `/api/admin` - logged the truncated `path: "/whoami"`, and
  the `route` fallback normalized the same truncated value.

## 0.14.0 - 2026-08-13

- Error lines get two more flat fields, lifted in the same shared capture path, so
  every emitter gains them with no call-site change:
  - `category` - the root cause bucketed into `timeout`, `connectivity`, `db` (a
    SQLSTATE such as `23505`/`42P01`) or `logic`. Classified from the ROOT cause, so
    a `TypeError: fetch failed` wrapper never hides the `ENOTFOUND` underneath.
    Always present: an unrecognised error is `logic`, our bug until proven otherwise.
  - `target` - what an outbound call was reaching for, `POST api.test:8443/v1/x/:id`:
    method, host with port, path templated by the same rule that names fetch spans.
    Query, hash and credentials never appear. Absent when unknown.
- `tracedFetch` now also attaches a non-enumerable `fetchTarget` to a rejection,
  computed before the await; `targetOf` reads it through any wrapping cause chain.
- `categoryOf`, `targetOf` and `fetchTargetOf` are exported for direct use.

## 0.13.0 - 2026-08-13

- Error lines get two new flat fields, lifted in the shared capture path so every
  emitter (Express, Next, MCP tools) gains them with no call-site change:
  - `cause` - deepest `.cause` in the chain (depth cap 5, cycle-safe) summarized as
    `Error: getaddrinfo ENOTFOUND agentage-web_backend`. When the error carries no
    application code, that cause's system `code` becomes `error_code`.
  - `frame` - top in-app stack frame, `src/provision.ts:42:11 in provisionMemory`;
    node_modules, `node:`, `internal/`, webpack-internal and native frames skipped.
- `tracedFetch(input, init?)` - `fetch` that captures the call site before awaiting
  and attaches it to a rejection as a non-enumerable `callSite`, so `frame` resolves
  for `TypeError: fetch failed`, which otherwise has no application frame at all.
- `rootCauseOf`, `causeChainOf`, `causeSummaryOf`, `causeCodeOf`, `frameOf` and
  `errorFrameFields` are exported for direct use.

## 0.11.0 - 2026-08-12

- Logs get the same simple API health got in 0.10.0:
  - `logger(options?)` - `createLogger` with every option optional; the service
    name defaults to `OTEL_SERVICE_NAME` (then the deliberately loud `unknown`),
    the same rule `/health` already uses.
  - `log.error(err)` / `log.fatal(err)` record the exception on the active trace
    span and flag it red by themselves. `log.error({ err, ...ctx })` captures
    too and defaults the message to the error's. Existing `log.error(err)` call
    sites gain trace flagging on upgrade with no code change.
  - `captureError` is no longer needed: it stays exported with the same
    signature as a thin wrapper over `log.error`.

## 0.10.1 - 2026-08-11

- README rewritten for people who did not write this package: what it is in plain
  language, a copy-paste quickstart per surface, the envelope and timing fields as
  tables, an API index, and the container/Docker gotchas that cost real outages.
  Docs only - no code change. Published so the npm page carries it.

## 0.10.0 - 2026-08-11

- `/health` gains a simple public API, additive to everything that exists:
  - `health(options?)` - fetch-native handler factory for Next routes, Hono,
    Cloudflare Workers, Deno and Bun. `health()` with no options is a valid
    liveness probe; add `checks` for readiness.
  - `nodeHealth(options?)` - `createHealthHandler` under the matching name.
  - `staticHealth(options?)` - `staticHealthJson` under the matching name.
  - `checks` now also accepts a keyed object: `{ db: () => pool.query('SELECT 1') }`
    or `{ cache: { run, timeoutMs: 250, optional: true } }`. The array form is
    unchanged and stays supported.
- Added the LICENSE file (the manifest always said MIT; now the text ships too)
  and this changelog.

## 0.9.1 - 2026-08-10

- Health module is edge-safe by construction: zero imports, Web APIs only
  (`performance.timeOrigin` instead of a Node-only uptime source), enforced by a
  source-text scan test that also covers comments and the built `dist` output.

## 0.9.0 - 2026-08-09

- Health envelope v1.1: `instance` (replica detection), `checkedAt` (cache
  detection), `durationMs`, per-check `timings`, `reasons`, bounded `facts`
  (`factsTimeoutMs`), and a `Server-Timing` response header.

## 0.8.0 and earlier

- OTLP trace bootstrap (`node --import`), pino logger preset with trace
  correlation, `captureError`, MCP span helpers, Next.js `register`, and the
  first `/health` envelope. History: git tags `v0.1.0`..`v0.8.1`.
