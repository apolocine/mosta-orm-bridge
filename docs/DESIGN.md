# @mostajs/orm-bridge — Design Document

**Author:** Dr Hamid MADANI <drmdh@msn.com>
**Version:** v0.1.0
**Date:** 2026-04-12
**License:** AGPL-3.0-or-later

---

## 1. Goals & Non-Goals

### Goals

- Let users keep their existing Prisma (and future Drizzle/TypeORM/Mongoose) code unchanged.
- Route specific models to any of the 13 databases @mostajs/orm supports — including Oracle, DB2, HANA, Sybase, HSQLDB, Spanner (none of which Prisma natively supports).
- Preserve full TypeScript inference of the source ORM (so IDE autocomplete, type checking, generated clients all keep working).
- Be an officially-supported extension point (no monkey-patching, no internals).
- Opt-in per model : unmapped models keep the source ORM's default behavior.

### Non-Goals (v0.1)

- Replace the source ORM's migration tool. Users still run `prisma migrate`.
- Replace the source ORM's studio. Prisma Studio still works on mapped models if their underlying schema is also known to Prisma.
- Implement every exotic feature (aggregate, groupBy, nested writes, transactions) — planned for v0.2+.
- Provide a full relational graph resolver (nested `include` / `select`) — v0.2.

---

## 2. Design decisions

### 2.1 Why `$extends` and not a Driver Adapter?

Prisma provides two official extension points :

| Mechanism | Pros | Cons |
|-----------|------|------|
| **Driver Adapter** (`SqlDriverAdapter`) | 100% type fidelity, query engine still generates SQL | SQL-only (no MongoDB/Oracle/etc.), Prisma picks the dialect |
| **`$extends` / `$allOperations`** | Works for ALL dialects, bypasses query engine | Args pre-typed but return shape on us |

We chose **`$extends`** because :

1. It's the only path that unlocks non-SQL dialects (MongoDB, etc.) and SQL dialects Prisma doesn't know (Oracle, DB2, HANA...).
2. It's an officially stable API since Prisma 4.16.
3. It works identically with Prisma 5.x, 6.x, and the new rust-free `prisma-client` generator.
4. `$use` middleware was removed in Prisma 6.14 — `$extends` is the sanctioned replacement.

### 2.2 Why opt-in per model?

Users rarely want to move every model off Prisma's native engine. A typical use case is :

- Keep `User`, `Post`, `Order` on Prisma + PostgreSQL (Prisma Studio, migrations, type safety all work).
- Add `AuditLog` on MongoDB (not supported by Prisma's query planner for this kind of write pattern).
- Add `InventoryItem` on the company's existing Oracle database.

Opt-in per model keeps the rest of the application unchanged and lets the bridge grow incrementally.

### 2.3 Why does a binding need an `EntitySchema`?

`@mostajs/orm` is schema-aware — its CRUD methods take an `EntitySchema` to know the table, fields, indexes, etc. The bridge passes this schema from the binding down to the dispatcher.

You can either :

1. **Provide the schema explicitly** (recommended) — copy/paste from an existing mosta-orm entity file.
2. **Let the bridge build a minimal schema** — derived from the model name. Works for simple read/write but may miss constraints.

Future versions will support :
- Importing the schema from a Prisma model definition automatically (via `@mostajs/orm-adapter`).
- Deriving from the dereferenced OpenAPI spec.

---

## 3. Architecture

### 3.1 Module layout

```
mosta-orm-bridge/
├── src/
│   ├── core/
│   │   ├── types.ts             # BridgeConfig, ModelBinding, InterceptEvent
│   │   └── dialect-registry.ts  # Lazy dialect cache (per URI)
│   ├── prisma/                  # Prisma-specific sub-module
│   │   ├── index.ts             # public API (@mostajs/orm-bridge/prisma)
│   │   ├── types.ts             # PrismaBridgeConfig, PrismaOperation
│   │   ├── extension.ts         # mostaExtension() factory
│   │   ├── dispatcher.ts        # routes operations → dialect calls
│   │   └── mappers/
│   │       ├── where.ts         # Prisma where → mosta FilterQuery
│   │       └── orderby.ts       # Prisma orderBy → mosta sort
│   ├── utils/
│   │   └── case-conversion.ts   # PascalCase ↔ snake_case plural
│   └── index.ts                 # root public API
├── test-scripts/                # integration tests (SQLite :memory:)
└── docs/
    ├── DESIGN.md                # (this file)
    └── HOW-TO-USE.md            # tutorials
```

### 3.2 Request lifecycle

```
 user writes:
   prisma.auditLog.findMany({ where: { userId: 'u1' } })
                                         │
                                         ▼
   ┌────────────────────────────────────────────────────┐
   │ Prisma Client ($extends layer intercepts here)     │
   └────────────────────────────────────────────────────┘
                                         │
             ┌───────────────────────────┴─────┐
             │ is this model mapped ?          │
             └─────────────┬───────────────────┘
                           │
             ┌─────────────┴─────────┐
             │                       │
            yes                      no
             │                       │
             ▼                       ▼
  ┌─────────────────┐       ┌────────────────────┐
  │ dispatcher.ts   │       │ pass-through :     │
  │ maps args       │       │ query(args)        │
  │ calls dialect   │       │ (Prisma native)    │
  └────────┬────────┘       └────────────────────┘
           │
           ▼
  ┌─────────────────┐
  │ @mostajs/orm    │
  │ dialect (pg,    │
  │ mongo, oracle…) │
  └─────────────────┘
           │
           ▼
       Database
```

### 3.3 Argument mapping

Prisma delivers pre-typed arguments in JS form. The dispatcher converts :

| Prisma input | mosta-orm input |
|--------------|-----------------|
| `where: {...}` | `filter: FilterQuery` (via `mapPrismaWhere`) |
| `orderBy: {...}` | `options.sort: Record<field, 1\|-1>` (via `mapPrismaOrderBy`) |
| `take: N` | `options.limit: N` |
| `skip: N` | `options.skip: N` |
| `data: {...}` | passed as-is (row literal) |
| `include`, `select` | ignored in v0.1 (planned v0.2) |

### 3.4 Return-shape contract

Prisma expects specific shapes. The dispatcher honors them :

| Operation | Return shape |
|-----------|--------------|
| `findMany` | array of rows |
| `findUnique` / `findFirst` | single row or `null` |
| `findUniqueOrThrow` | single row (throws if not found) |
| `count` | number |
| `create` | the created row |
| `createMany` | `{ count: number }` |
| `update` / `upsert` | the updated row |
| `updateMany` | `{ count: number }` |
| `delete` | the deleted row |
| `deleteMany` | `{ count: number }` |

### 3.5 Dialect caching

Multiple models can share the same connection. We cache dialect instances by `dialect+uri` :

```ts
const key = `${dialect}::${uri}`;
cache: Map<string, Promise<IDialect>>
```

`initSchema()` is run once per `(connection, schema.name)` — subsequent calls are no-ops via an `schemasInit: Set<string>` guard.

### 3.6 Error handling

- Mapped model with invalid args → throw with clear Prisma-style message.
- `findUniqueOrThrow` on missing row → throw `Error(${modelName} not found)`.
- Unsupported operation (aggregate, groupBy) → throw with a message pointing to the v0.2 plan.
- Unmapped model with `fallback: 'error'` → throw before Prisma runs.
- Connection failure → surface underlying driver error, clear from cache so a retry can succeed.

---

## 4. Trade-offs & Known Limitations

### 4.1 Type safety is partial

Prisma's generated types for return values assume Prisma's query engine shape. If our dispatcher returns an incompatible shape (e.g. a MongoDB `_id` instead of `id`), TypeScript won't complain but runtime will drift.

**Mitigation :** the dispatcher normalizes `_id` ↔ `id` lookups in `update` / `delete` / `upsert`. Users should ensure their EntitySchema uses `id` as the primary-key name (the canonical mosta-orm convention).

### 4.2 Nested include/select is not implemented yet

A Prisma query like `prisma.user.findMany({ include: { posts: true } })` will currently return users without `posts`. v0.2 will add:

- Schema-aware relation loader (from `EntitySchema.relations`).
- `include: true` → fetch and hydrate.
- `include: { nested: { ... } }` → recursive load.
- `select` → field projection on hydrated result.

### 4.3 Transactions not supported

`prisma.$transaction([...])` and interactive transactions are planned for v0.3. For now, users should do atomic work manually against the dialect.

### 4.4 Prisma-managed schema vs mosta-managed

If you map `AuditLog` to a MongoDB database that Prisma doesn't know about, **Prisma migrations won't create/update that collection**. The bridge will use the `EntitySchema` you provide at runtime (with `schemaStrategy: 'create'` or `'update'` in the connection config if you want mosta-orm to manage DDL too).

**Recommendation :** if a model is bridged, manage its schema from mosta-orm (or manually) — not from Prisma.

---

## 5. Security considerations

- The bridge does not sanitize input beyond what `@mostajs/orm` already does (parameterized queries in all dialects).
- `mapPrismaWhere` escapes user input passed to `contains`/`startsWith`/`endsWith` as a regex — no regex injection.
- Connection URIs are logged only when `onIntercept` callback explicitly echoes them. Users should not log URIs in production.
- Credentials in `config.models[*].url` live only in memory; dialects cache them in their driver's connection pool.

---

## 6. Roadmap alignment

| Version | Scope | Target |
|---------|-------|--------|
| v0.1.0 | Prisma : CRUD + basic filters | **shipped** |
| v0.2.0 | Prisma : aggregate, groupBy, include, select, transactions | Q2 2026 |
| v0.3.0 | Drizzle bridge (same patterns) | Q2 2026 |
| v0.4.0 | TypeORM bridge | Q3 2026 |
| v0.5.0 | Mongoose bridge | Q3 2026 |
| v1.0.0 | All bridges production-ready, docs, perf work | Q4 2026 |

---

## 7. References

- [Prisma Client extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query)
- [Prisma Driver Adapters](https://www.prisma.io/docs/orm/overview/databases/database-drivers) (alternative approach we did NOT pick — see §2.1)
- [@mostajs/orm IDialect interface](https://github.com/apolocine/mosta-orm/blob/main/src/core/types.ts)
- [Entreprise/SchemaAdapters/05-Interception-Runtime-Prisma-OpenAPI-JsonSchema.md](../../Entreprise/SchemaAdapters/05-Interception-Runtime-Prisma-OpenAPI-JsonSchema.md) — original design study

---

*@mostajs/orm-bridge DESIGN v0.1 — Dr Hamid MADANI drmdh@msn.com*
