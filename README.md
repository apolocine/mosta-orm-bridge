# @mostajs/orm-bridge

> **Keep your Prisma code. Get 13 databases.**
>
> Runtime bridge that exposes a drop-in `PrismaClient`-compatible object backed by [@mostajs/orm](https://github.com/apolocine/mosta-orm). Your existing `db.user.findMany(...)` / `db.User.aggregate(...)` calls keep working — on SQLite, PostgreSQL, MongoDB, Oracle, DB2, HANA, HSQLDB, Spanner, Sybase, CockroachDB, MySQL, MariaDB, SQL Server.

[![npm version](https://img.shields.io/npm/v/@mostajs/orm-bridge.svg)](https://www.npmjs.com/package/@mostajs/orm-bridge)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

## The 3-line migration

Replace your Prisma `db.ts` / `prisma.ts` with :

```ts
// src/lib/db.ts
import { createPrismaLikeDb } from '@mostajs/orm-bridge/prisma-client'
export const db = createPrismaLikeDb()
```

That's it. Every file that already does `import { db } from '@/lib/db'` and calls `db.User.findUnique(...)`, `db.member.create(...)`, `db.$transaction(...)` keeps running — except now it runs on @mostajs/orm and any of the 13 databases.

**Too many PrismaClient instantiation sites in your codebase to rewrite by hand ?** Use the codemod :

```bash
npx @mostajs/orm-cli install-bridge --apply
```

It scans your project, detects every `new PrismaClient(...)`, preserves the original export name (`prisma`, `db`, `client`, default), and rewrites each file — with backups as `*.prisma.bak`.

## Install

```bash
npm install @mostajs/orm @mostajs/orm-bridge --legacy-peer-deps
# + the driver for your target dialect :
npm install better-sqlite3         # sqlite   (default)
# or: pg / mysql2 / mongoose / oracledb / mssql / mariadb / ibm_db / @sap/hana-client / @google-cloud/spanner
```

## Configuration

Read from environment variables by default :

```bash
DB_DIALECT=sqlite                       # or postgres, mongodb, oracle, ...
SGBD_URI=./data.sqlite                  # or postgres://…, mongodb://…
DB_SCHEMA_STRATEGY=update               # validate | update | create | create-drop | none
```

Entities are loaded from `.mostajs/generated/entities.json` (produced by `npx @mostajs/orm-cli` — menu 1 `Convert`).

Explicit config :

```ts
import { createPrismaLikeDb } from '@mostajs/orm-bridge/prisma-client'
import entities from './entities.json'
export const db = createPrismaLikeDb({
  entities,
  dialect: 'postgres',
  uri: process.env.DATABASE_URL!,
  schemaStrategy: 'update',
  caseInsensitive: true,        // db.User === db.user (default)
  resolveInclude:  true,        // post-fetch many-to-one relations (default)
  onIntercept: e => console.log(`${e.model}.${e.operation} (${e.duration}ms)`),
})
```

## Supported Prisma operations

| Operation | Status |
|---|---|
| `findUnique`, `findFirst`, `findUniqueOrThrow`, `findFirstOrThrow` | ✅ |
| `findMany` with `where`, `orderBy`, `take`, `skip` | ✅ |
| `count` | ✅ |
| `create`, `createMany` | ✅ |
| `update`, `updateMany` | ✅ |
| `upsert` | ✅ |
| `delete`, `deleteMany` | ✅ |
| `aggregate` (`_count`, `_sum`, `_avg`, `_min`, `_max` + filter) | ✅ v0.2.1 |
| `groupBy` (single `by` field, `_count`, `_sum`, `_avg`, `_min`, `_max`, `orderBy`, `take`) | ✅ v0.2.1 |
| `include: { <relation>: true }` — many-to-one post-fetch | ✅ |
| `$connect`, `$disconnect` | ✅ |
| `$transaction` array (sequential) | ✅ |
| `$transaction` callback — real ACID (BEGIN / COMMIT / ROLLBACK on SQL) | ✅ v0.3.0 |
| Nested writes (`create`, `connect`, `createOrConnect`, `set`, `disconnect`, `update`, `delete`, `upsert`) | ✅ v0.3.0 |
| `connect: { where: { id } }` **and** `connect: { where: { <anyUniqueKey> } }` (single + composite) | ✅ v0.3.0 |
| `include: { <relation>: { where, orderBy, take, skip, select, include } }` (1:1, N:1, 1:N, N:N + nested) | ✅ v0.3.0 |
| Multi-field `groupBy` | 🚧 (requires upstream `@mostajs/orm` change) |

## Supported Prisma `where` operators

| Prisma | @mostajs/orm |
|--------|-----------|
| `{ field: value }` | direct equality |
| `equals` / `not` | `$eq` / `$ne` |
| `gt`, `gte`, `lt`, `lte` | `$gt`, `$gte`, `$lt`, `$lte` |
| `in`, `notIn` | `$in`, `$nin` |
| `contains`, `startsWith`, `endsWith` | `$regex` (escaped / anchored) |
| `mode: 'insensitive'` | `$regexFlags: 'i'` |
| `AND`, `OR` | `$and`, `$or` |
| `NOT` | best-effort condition inversion |

## Nested writes (v0.3.0)

Prisma's nested writes are supported on relations at any depth. The connector resolves `connect` by primary id **or by any declared unique key** — including composite ones — so your existing Prisma schema keeps working without changes.

```ts
// 1:N — create the parent and its children in one call
await db.User.create({
  data: {
    email: 'ada@lovelace.io',
    posts: {
      create: [
        { title: 'Note engine' },
        { title: 'Analytical engine' },
      ],
    },
  },
})

// connect by id OR by any unique field / composite unique
await db.Post.create({
  data: {
    title: 'Shared draft',
    author:  { connect: { id: 42 } },
    reviewer:{ connect: { email: 'byron@poet.uk' } },           // single unique
    topic:   { connect: { tenantId_slug: { tenantId: 't1', slug: 'ada' } } }, // composite
  },
})

// createOrConnect — upsert-like for relations
await db.Order.create({
  data: {
    total: 199,
    customer: {
      connectOrCreate: {
        where:  { email: 'guest@x.io' },
        create: { email: 'guest@x.io', name: 'Guest' },
      },
    },
  },
})
```

**Atomicity** — every nested write is executed inside an implicit `$transaction` on the underlying `@mostajs/orm` dialect. If any child operation fails, the parent and every already-inserted sibling are rolled back (SQL dialects). See [`@mostajs/orm` → Transactions](https://github.com/apolocine/mosta-orm#transactions) for isolation semantics and MongoDB specifics.

## Advanced include (v0.3.0)

`include` accepts the full Prisma filter surface on relations : `where`, `orderBy`, `take`, `skip`, `select`, and nested `include`.

```ts
await db.User.findMany({
  where: { status: 'active' },
  include: {
    posts: {
      where:   { publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take:    5,
      select:  { id: true, title: true, publishedAt: true },
    },
    profile: true,
  },
})

// nested include — 2 levels deep
await db.Org.findUnique({
  where:   { slug: 'acme' },
  include: {
    members: {
      orderBy: { joinedAt: 'asc' },
      include: {
        user: { select: { email: true, name: true } },
      },
    },
  },
})
```

Filters and ordering run on the same dialect as the outer query — no N+1, no post-fetch sort.

## Two ways to use the bridge

### 1. `createPrismaLikeDb()` — the drop-in (recommended)

Replaces PrismaClient entirely. No `@prisma/client` runtime needed. **Any** target dialect.

```ts
import { createPrismaLikeDb } from '@mostajs/orm-bridge/prisma-client'
export const db = createPrismaLikeDb()
```

### 2. `mostaExtension()` — keep Prisma, add dialects

Keeps PrismaClient as your primary engine and only routes specific models to mosta-orm (useful if you want the analytics table on PostgreSQL while the rest stays on Prisma).

```ts
import { PrismaClient } from '@prisma/client'
import { mostaExtension } from '@mostajs/orm-bridge/prisma'

const prisma = new PrismaClient().$extends(mostaExtension({
  models: {
    AuditLog: { dialect: 'mongodb', url: process.env.MONGO_URL!, schema: AuditLogSchema },
  },
  fallback: 'source',   // unmapped models go through Prisma's default engine
}))
```

## Architecture

```
┌───────────────────────┐     ┌──────────────────────────┐
│ your app              │     │ createPrismaLikeDb()     │
│ db.User.findMany(...) │ ──▶ │ Proxy + dispatcher       │
└───────────────────────┘     └────────────┬─────────────┘
                                           │
                                           ▼
                              ┌──────────────────────────┐
                              │ @mostajs/orm dialect     │
                              │ (lazy-loaded driver only)│
                              └────────────┬─────────────┘
                                           ▼
                      SQLite · Postgres · Mongo · Oracle · …
                              (13 databases)
```

## Bundler-friendly

The bridge works out of the box in **Next.js (App Router + pages/)**, **Vite SSR**, **SvelteKit**, **Remix** — no `serverExternalPackages` workaround needed. The trick : `@mostajs/orm@1.9.3+` hides its dialect imports from webpack's static analysis, and `@mostajs/orm@1.9.4+` isolates the JDBC subprocess code in a separate subpath (`@mostajs/orm/bridge`).

## Roadmap

- **v0.1.0** — `mostaExtension` (Prisma `$extends`) : CRUD + filters ✅
- **v0.2.0** — `createPrismaLikeDb()` drop-in factory ✅
- **v0.2.1** — aggregate + groupBy + bare specifiers ✅
- **v0.3.0** — nested writes, real ACID `$transaction`, `_count` per-field
- **v0.4.0** — Drizzle bridge (`@mostajs/orm-bridge/drizzle`)
- **v0.5.0** — TypeORM bridge
- **v0.6.0** — Mongoose bridge

## Ecosystem

- [@mostajs/orm](https://www.npmjs.com/package/@mostajs/orm) — the underlying ORM (13 dialects, Hibernate-inspired)
- [@mostajs/orm-cli](https://www.npmjs.com/package/@mostajs/orm-cli) — `mostajs bootstrap` and `mostajs install-bridge` automate the whole migration
- [@mostajs/orm-adapter](https://www.npmjs.com/package/@mostajs/orm-adapter) — Prisma / JSON Schema / OpenAPI → EntitySchema

## License

**AGPL-3.0-or-later** + commercial license available.

For closed-source commercial use : drmdh@msn.com

## Author

Dr Hamid MADANI <drmdh@msn.com>
