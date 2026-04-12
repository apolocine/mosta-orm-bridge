# @mostajs/orm-bridge

> **Keep your Prisma code. Gain access to 13 databases.**
>
> Runtime bridges for third-party ORMs — intercept their calls and redirect them to [@mostajs/orm](https://github.com/apolocine/mosta-orm) without rewriting a single line of your existing code.

[![npm version](https://img.shields.io/npm/v/@mostajs/orm-bridge.svg)](https://www.npmjs.com/package/@mostajs/orm-bridge)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

## Why

Prisma supports **7 databases** (PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, CockroachDB, MariaDB).

@mostajs/orm supports **13** (all of the above plus Oracle, DB2, HANA, HSQLDB, Spanner, Sybase — with more coming).

**This bridge lets you use Prisma's API on any of these 13 databases** — zero code change other than PrismaClient construction.

```ts
// Before
const prisma = new PrismaClient();
await prisma.user.findMany();  // only works on Prisma's 7 DBs

// After
const prisma = new PrismaClient({ datasourceUrl: 'sqlite::memory:' })
  .$extends(mostaExtension({
    models: {
      User: { dialect: 'oracle', url: 'oracle://...', schema: UserSchema }
    }
  }));

await prisma.user.findMany();  // now runs on Oracle!
// Full Prisma types preserved, zero other changes.
```

## Install

```bash
npm install @mostajs/orm-bridge @mostajs/orm @prisma/client
```

## Quick start

```ts
import { PrismaClient } from '@prisma/client';
import { mostaExtension } from '@mostajs/orm-bridge/prisma';
import type { EntitySchema } from '@mostajs/orm';

const AuditLogSchema: EntitySchema = {
  name: 'AuditLog',
  collection: 'audit_logs',
  fields: {
    userId: { type: 'string', required: true },
    action: { type: 'string', required: true },
    timestamp: { type: 'date', required: true },
  },
  relations: {},
  indexes: [{ fields: { userId: 'asc' } }],
  timestamps: true,
};

const prisma = new PrismaClient({
  datasourceUrl: 'sqlite::memory:',  // no-op placeholder
}).$extends(mostaExtension({
  models: {
    AuditLog: {
      dialect: 'mongodb',
      url: process.env.MONGO_URL!,
      schema: AuditLogSchema,
    },
  },
  onIntercept: (e) => console.log(`[bridge] ${e.model}.${e.operation} → ${e.dialect} (${e.duration}ms)`),
}));

// Prisma → MongoDB via mosta-orm
await prisma.auditLog.create({
  data: { userId: 'u1', action: 'login', timestamp: new Date() }
});

const logs = await prisma.auditLog.findMany({
  where: { userId: 'u1', timestamp: { gte: new Date('2026-01-01') } },
  orderBy: { timestamp: 'desc' },
  take: 10,
});

// Other models NOT in config.models still go through Prisma's default engine
await prisma.user.findMany();  // unchanged behavior
```

## Architecture

```
┌────────────────────────┐
│   Your app (Prisma)     │
│   prisma.user.findMany()│
└──────────┬──────────────┘
           │
           ▼
┌────────────────────────┐
│   PrismaClient          │
│   $extends($allModels)  │
└──────────┬──────────────┘
           │
     ┌─────┴──────┐
     │            │
  mapped?        no
     │            │
     ▼            ▼
  mosta-orm   Prisma default
  dialect     query engine
     │
     ▼
 ┌──────────────────────┐
 │  13 databases        │
 │  PG / MySQL / Oracle │
 │  MongoDB / DB2 /     │
 │  HANA / HSQLDB /     │
 │  Spanner / Sybase ...│
 └──────────────────────┘
```

## Supported Prisma operations

| Operation | Supported | Notes |
|-----------|-----------|-------|
| `findUnique`, `findFirst`, `findUniqueOrThrow`, `findFirstOrThrow` | YES | Maps `where` to mosta FilterQuery |
| `findMany` | YES | Supports `where`, `orderBy`, `take`, `skip` |
| `count` | YES | |
| `create`, `createMany` | YES | |
| `update`, `updateMany` | YES | |
| `upsert` | YES | |
| `delete`, `deleteMany` | YES | |
| `aggregate`, `groupBy` | v0.2 | Planned |
| Nested `include` / `select` | v0.2 | Planned |
| Transactions | v0.3 | Planned |

## Supported Prisma `where` operators

| Prisma | mosta-orm |
|--------|-----------|
| `{ field: value }` | direct equals |
| `equals` | `$eq` |
| `not` | `$ne` |
| `gt`, `gte`, `lt`, `lte` | `$gt`, `$gte`, `$lt`, `$lte` |
| `in`, `notIn` | `$in`, `$nin` |
| `contains` | `$regex` (escaped) |
| `startsWith`, `endsWith` | `$regex` (anchored) |
| `mode: 'insensitive'` | `$regexFlags: 'i'` |
| `AND`, `OR` | `$and`, `$or` |
| `NOT` | best-effort condition inversion |

## Configuration reference

```ts
interface PrismaBridgeConfig {
  /** Model name → mosta-orm binding */
  models: Record<string, ModelBinding>;

  /** What to do when a model is not mapped (default: 'source') */
  fallback?: 'source' | 'error';

  /** Observability hook */
  onIntercept?: (event: InterceptEvent) => void;
}

interface ModelBinding {
  dialect: DialectType;              // 'postgres', 'mongodb', 'oracle', ...
  url?: string;                      // connection URI
  connection?: ConnectionConfig;     // full config alternative
  collection?: string;               // override table name
  schema?: EntitySchema;             // mosta-orm schema (recommended)
}
```

## Roadmap

- **v0.1.0** — Prisma bridge MVP (CRUD + filters + orderBy) ✅
- **v0.2.0** — aggregate / groupBy / nested include / transactions
- **v0.3.0** — Drizzle bridge (same pattern for Drizzle ORM)
- **v0.4.0** — TypeORM bridge
- **v0.5.0** — Mongoose bridge

## How it works

We use Prisma's official [`$extends`](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query) API — a stable extension point. The `$allOperations` handler intercepts every model call and decides whether to:

- **Forward to mosta-orm** (if the model is in `config.models`) — runs the query on the mapped dialect, returning the result in Prisma's expected shape.
- **Pass through to Prisma** (otherwise) — normal Prisma behavior.

No monkey-patching. No Prisma internals hacked. Works with Prisma 5.4+ (including the new rust-free `prisma-client` generator in Prisma 6.16+).

## License

**AGPL-3.0-or-later** + commercial license available.

For commercial use in closed-source projects, contact: drmdh@msn.com

## Author

Dr Hamid MADANI <drmdh@msn.com>

---

Part of the [@mostajs ecosystem](https://github.com/apolocine) — 13 databases, 11 transports, one unified backend.
