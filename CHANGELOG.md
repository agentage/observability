# Changelog

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
