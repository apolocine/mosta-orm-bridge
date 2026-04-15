# Changelog

All notable changes to `@mostajs/orm-bridge` will be documented in this file.

## [0.3.1] — 2026-04-15

### Fixed — env vars resolved lazily, not at construction

- **`createPrismaLikeDb()` now reads `process.env.DB_DIALECT` / `SGBD_URI` /
  `DB_SCHEMA_STRATEGY` lazily (at first DB call), not at top-level.**
  Pre-0.3.1, `db.ts` calling `createPrismaLikeDb()` at module top-level
  could observe an empty `process.env` if Next.js / a bundler imported
  `db.ts` before dotenv populated env vars — silently locking the bridge
  to the `sqlite ./data.sqlite` fallback even when `.env` was correctly
  set with Oracle / Postgres / Mongo creds. Symptom : login fails with
  "user not found", queries hit an empty local SQLite, no error logged.
- **Cached dialect is keyed on the connection signature**
  (`dialect|uri|strategy`). If env changes between two requests
  (HMR reload, restart with new `.env`), the previous dialect is closed
  cleanly and a fresh one is opened against the new target.
- **One-time warning** on `process.env.DB_DIALECT` missing — surfaces
  silent fallbacks the first time they happen.

## [0.3.0] — 2026-04-14

### Added — full Prisma parity on nested ops, real ACID, advanced include

- **Nested writes** on every relation type (1:1, N:1, 1:N, N:N via `through`) :
  `create`, `createMany`, `connect`, `connectOrCreate`, `set`, `disconnect`,
  `update`, `updateMany`, `delete`, `deleteMany`, `upsert`.
- **`connect: { where: { ... } }`** accepts **any** unique key, not just
  `id`. Single-field unique *and* composite `@@unique` indexes are both
  resolved automatically via `findUniqueMatch`.
- **Real ACID `$transaction`** routed to `dialect.$transaction` (new in
  `@mostajs/orm@1.10.0`). `db.$transaction(async tx => { ... })` rolls
  back every write in the callback on throw. The array form still works
  (`db.$transaction([p1, p2])`, sequential).
- **Advanced `include`** : `include: { rel: { where, orderBy, take, skip, select, include } }`
  works on all four relation types with nested recursion. Projection via
  `select` keeps the `id` automatically so downstream joins resolve.
- **Inverse 1:1 detection** : handles the case where the Prisma→EntitySchema
  adapter emits an inverse 1:1 as `many-to-one` without `joinColumn`. The
  bridge now infers the child-side FK via the target's back-reference.

### Peer dependencies

- `@mostajs/orm` peer bumped to `^1.10.0` (required for `$transaction`).

### Tests

- `test-nested-writes.ts`               — 9 / 9 ✓
- `test-transaction-acid.ts`            — 8 / 8 ✓
- `test-advanced-include.ts`            — 14 / 14 ✓
- `test-edge-cases.ts`                  — 22 / 22 ✓
- `test-fitzonegym-integration.ts`      — 15 / 15 ✓ (real 40-entity Prisma schema)
- `test-prisma-client.ts`               — 16 / 16 ✓
- `test-prisma-bridge.ts`               — 14 / 14 ✓

Total: **7 test files, all green.**

### Fixes discovered on real-world integration (FitZoneGym)

- Many-to-many junction tables no longer use `dialect.create/find` (which
  would inject a phantom `id` column). `INSERT` / `DELETE` / `SELECT` are
  now issued as raw SQL via `executeRun` / `executeQuery`.
- Nested creates recurse properly when a nested `{ create: [...] }`
  payload itself contains `{ connect: { ... } }` on a many-to-one FK
  (e.g. `Member.subscriptions.create → { plan: { connect }, createdBy: { connect } }`).

## [0.2.1] — 2026-04-14

### Added

- **Prisma `aggregate` and `groupBy` support** in the dispatcher. Maps
  `_count`, `_sum`, `_avg`, `_min`, `_max` accumulators to @mostajs/orm's
  `AggregateStage[]` pipeline, then reshapes the result back to Prisma's
  nested output shape. Works with `where`, `orderBy`, `take` on `groupBy`.
- **test-scripts/test-prisma-client.ts** — full-surface suite covering
  CRUD + aggregate + groupBy + `$transaction` on real SQLite. 16/16 passing.

### Known limitation

- `groupBy` accepts a single field in `by`. Multi-field groupBy throws with
  an explicit error pointing at the @mostajs/orm `AggregateGroupStage._by`
  limitation — will be lifted once upstream accepts an array.
- Per-field `_count: { field: true }` currently counts total rows (not
  non-null per field). A future release will issue multiple sub-queries or
  rely on upstream `$sum` of `$cond` once available.

## [0.2.0] — 2026-04-14

### Added

- **`createPrismaLikeDb()`** (`@mostajs/orm-bridge/prisma-client`) : one-call
  factory that returns a Prisma-compatible `db` proxy backed by @mostajs/orm.
  Replaces hand-written per-project `db.ts` adapters. Standardises the
  Prisma → mosta-orm migration :

  ```ts
  // src/lib/db.ts — now 2 lines
  import 'server-only';
  import { createPrismaLikeDb } from '@mostajs/orm-bridge/prisma-client';
  export const db = createPrismaLikeDb();
  ```

  The factory :
  - auto-loads EntitySchema[] from `.mostajs/generated/entities.json`
    (configurable via `entitiesPath` or `entities`)
  - reads `DB_DIALECT`, `SGBD_URI`, `DB_SCHEMA_STRATEGY` from env
  - supports case-insensitive access (`db.User` === `db.user`)
  - post-processes `include: { <relation>: true }` for many-to-one
  - exposes root client methods `$connect`, `$disconnect`, `$transaction`
    (sequential pass-through)
  - lazy-imports `@mostajs/orm` to stay friendly with Next.js bundlers
  - emits optional `onIntercept` events for telemetry

### Changed

- **Peer dep bump** : `@mostajs/orm` `^1.9.0` → `^1.9.3` (lazy dialect loader
  required for Next.js client-bundle compatibility).

### Validated

FitZoneGym migration from Prisma+MongoDB to @mostajs/orm+SQLite now requires
modifying only `src/lib/db.ts` (2 lines) — the 67 other files importing Prisma
compile and run unchanged.

## [0.1.0] — 2026-04-12

### Added

- **Prisma Bridge** (`@mostajs/orm-bridge/prisma`) : runtime interception for Prisma Client via `$extends` API.
- **CRUD operations supported** :
  - `findUnique`, `findUniqueOrThrow`
  - `findFirst`, `findFirstOrThrow`
  - `findMany` (with `where`, `orderBy`, `take`, `skip`)
  - `count`
  - `create`, `createMany`
  - `update`, `updateMany`
  - `upsert`
  - `delete`, `deleteMany`
- **Where mapper** covers all major Prisma operators :
  - equality (`equals`, shorthand field: value)
  - comparison (`gt`, `gte`, `lt`, `lte`, `not`)
  - sets (`in`, `notIn`)
  - string ops (`contains`, `startsWith`, `endsWith` with `mode: 'insensitive'`)
  - logical (`AND`, `OR`, `NOT`)
- **OrderBy mapper** : simple form + array form + nested sort objects
- **Lazy dialect registry** : caches connections by URI, idempotent schema init
- **Fallback mode** : unmapped models pass through to Prisma's default engine
- **Observability hook** (`onIntercept`) for logging/metrics

### Package structure

- `@mostajs/orm-bridge` — root (shared core)
- `@mostajs/orm-bridge/prisma` — Prisma-specific bridge (this release)
- Future sub-modules : `/drizzle`, `/typeorm`, `/mongoose` (v0.3+)

### Tests

28 integration tests on SQLite `:memory:` covering all supported operations.

### License

AGPL-3.0-or-later + commercial license option (drmdh@msn.com).
