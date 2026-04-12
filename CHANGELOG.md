# Changelog

All notable changes to `@mostajs/orm-bridge` will be documented in this file.

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
