# CLAUDE.md - @agentage/observability

Shared observability kit for the agentage estate. Rules below are load-bearing; read before changing anything.

## Surface is frozen at 8

v1.0 targets **8 public exports**: `log`, `span`, `setUser`, `health`, plus the `bootstrap`, `next`, `browser` and root entries. Every consumer learns those and nothing else. Adding a 9th needs explicit justification in the PR body - "a service needed it" is not one; wire it behind an existing export instead.

## Internals are never exported for tests

No `_internal` barrel, no `export` added so a unit test can reach a helper. Test through the public entries only. If something is untestable from the outside, that is a design signal, not a reason to widen the surface.

## `health.ts` must stay edge-safe

Zero imports, Web APIs only - no `node:` import, no Node-only `process.*`, not even inside a comment (`tsc` emits comments into `dist`). `test/edge-safety.test.ts` reads the raw source text to enforce it.

This guards a real incident: on 2026-08-10 a Node API in this module 500'd every authenticated route on `admin.agentage.io`, because the module reaches the Edge Runtime through shared barrels and bundlers detect Node APIs **statically**. A `typeof` guard does not help. Never soften or skip that test.

## README documents shapes, not functions

The README describes **shapes** (wide event, ErrorEvent, health envelope) and **env vars** - the contract consumers depend on. It is not an API reference. A change that would require a new function row in an API table is the wrong change: it means the surface grew.

## Dependencies stay thin

A consumer installs 41 packages, not 106. `@opentelemetry/api` is a **peer** (global
singleton - two copies put spans on the wrong provider), and the datastore/queue
instrumentations (`pg`, `mongodb`, `redis`, `amqplib`) are **optional peers** loaded through
a guarded `await import()`: missing means skipped at debug level, never a failed boot. Adding
a hard dependency needs the same justification as adding a public export.

## Release

Version bump on `master` -> `release.yml` publishes to npm (a version already published is a skip). `train.yml` cuts the bump every Friday, minor by default, `major` only on manual dispatch. Never `npm publish` from a terminal.
