# Changelog

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
