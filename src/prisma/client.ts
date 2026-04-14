// @mostajs/orm-bridge — `createPrismaLikeDb()` factory
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later
//
// Drop-in replacement for `new PrismaClient()`.
//
// Usage in a Next.js / Node project migrating off Prisma :
//
//   // src/lib/db.ts
//   import 'server-only';
//   import { createPrismaLikeDb } from '@mostajs/orm-bridge/prisma-client';
//   export const db = createPrismaLikeDb();
//
// That's it. Any existing `db.User.findUnique(...)`, `db.member.findMany(...)`,
// `db.$connect()` etc. keeps working — calls are routed to @mostajs/orm.
//
// Configuration is read from environment variables by default :
//   DB_DIALECT            sqlite | postgres | mongodb | mysql | mariadb | oracle | mssql | db2 | cockroachdb | hana | hsqldb | spanner | sybase
//   SGBD_URI              connection URI (e.g. ./data.sqlite, postgres://...)
//   DB_SCHEMA_STRATEGY    none | update | create-drop | validate   (default: update)
//
// Entities are loaded from `.mostajs/generated/entities.json` by default (the
// file produced by `npx @mostajs/orm-cli` menu 1 — Convert). You can also pass
// them explicitly via `entities: [...]`.
//
// Supported Prisma model operations (delegated to dispatchPrismaOp) :
//   findUnique, findFirst, findUniqueOrThrow, findFirstOrThrow, findMany,
//   count, create, createMany, update, updateMany, upsert, delete, deleteMany.
//
// Supported root client methods :
//   $connect, $disconnect, $transaction (sequential pass-through — no ACID).
//
// `include: { <relation>: true }` is post-processed for many-to-one relations
// by issuing a follow-up `findOne` on the related entity. Nested writes,
// `aggregate`, and `groupBy` are not supported yet (error on call).

// NB: import the bare names ('fs' instead of 'node:fs'). Some Next/webpack
// configs choke on the 'node:' scheme prefix when a dep is inadvertently
// pulled into a pages/ build. Bare names work everywhere.
import { readFileSync } from 'fs';
import { resolve as pathResolve } from 'path';
import type { IDialect, EntitySchema, DialectType, SchemaStrategy } from '@mostajs/orm';
import { dispatchPrismaOp } from './dispatcher.js';

export interface CreatePrismaLikeDbOptions {
  /** EntitySchema[] to use. If omitted, read from `entitiesPath`. */
  entities?: EntitySchema[];

  /** Path to entities.json (default: `.mostajs/generated/entities.json` relative to cwd). */
  entitiesPath?: string;

  /** Database dialect. Default: `process.env.DB_DIALECT` (or `sqlite` if missing). */
  dialect?: DialectType;

  /** Connection URI. Default: `process.env.SGBD_URI` (or `./data.sqlite` if missing). */
  uri?: string;

  /** Schema strategy. Default: `process.env.DB_SCHEMA_STRATEGY` or `update`. */
  schemaStrategy?: SchemaStrategy;

  /**
   * When true (default), `db.User` and `db.user` both resolve to the entity
   * named `User`. Set to false to require exact casing.
   */
  caseInsensitive?: boolean;

  /**
   * When true (default), `include: { <relation>: true }` triggers a follow-up
   * fetch on the related entity for every returned row (many-to-one only).
   */
  resolveInclude?: boolean;

  /** Optional logger hook for each dispatched model operation. */
  onIntercept?: (e: { model: string; operation: string; duration: number; error?: Error }) => void;
}

/**
 * Build a Prisma-compatible `db` proxy backed by @mostajs/orm.
 *
 * The returned object exposes one property per entity (`db.User`,
 * `db.Member`, …) plus the Prisma client root methods (`$connect`,
 * `$disconnect`, `$transaction`). It is safe to create once per process
 * and share across modules.
 */
export function createPrismaLikeDb<T = any>(opts: CreatePrismaLikeDbOptions = {}): T {
  const dialect: DialectType =
    opts.dialect ?? (process.env.DB_DIALECT as DialectType) ?? 'sqlite';
  const rawUri: string =
    opts.uri ?? process.env.SGBD_URI ?? './data.sqlite';
  const uri: string =
    dialect === 'sqlite' ? rawUri.replace(/^sqlite:\/?\/?/, '') : rawUri;
  const strategy: SchemaStrategy =
    opts.schemaStrategy ?? (process.env.DB_SCHEMA_STRATEGY as SchemaStrategy) ?? 'update';
  const caseInsensitive = opts.caseInsensitive !== false;
  const resolveInc = opts.resolveInclude !== false;

  // --- Resolve entities ---
  let entities: EntitySchema[] = [];
  if (opts.entities) {
    entities = opts.entities;
  } else {
    const path = opts.entitiesPath ?? pathResolve(process.cwd(), '.mostajs/generated/entities.json');
    try {
      entities = JSON.parse(readFileSync(path, 'utf8')) as EntitySchema[];
    } catch (e) {
      console.error(
        `[@mostajs/orm-bridge] Cannot load entities from ${path} — run \`npx @mostajs/orm-cli\` menu 1 (Convert) first.\n` +
        `  Reason : ${(e as Error).message}`
      );
    }
  }
  const entityByKey = new Map<string, EntitySchema>(
    entities.map(e => [caseInsensitive ? e.name.toLowerCase() : e.name, e])
  );

  // --- Lazy-init dialect (singleton across HMR in dev) ---
  const globalScope = globalThis as unknown as { __mostaPrismaLikeDialect?: IDialect };
  async function getD(): Promise<IDialect> {
    if (globalScope.__mostaPrismaLikeDialect) return globalScope.__mostaPrismaLikeDialect;
    // Lazy import @mostajs/orm to mirror the bridge's no-static-edge pattern
    const { getDialect } = await import('@mostajs/orm');
    const d = await getDialect({ dialect, uri, schemaStrategy: strategy } as any);
    globalScope.__mostaPrismaLikeDialect = d;
    return d;
  }

  // --- include post-processing (many-to-one only) ---
  async function applyInclude(
    row: any,
    entity: EntitySchema,
    include: Record<string, any> | undefined
  ): Promise<any> {
    if (!row || !include) return row;
    const d = await getD();
    for (const [relName, want] of Object.entries(include)) {
      if (!want) continue;
      const rel = entity.relations?.[relName];
      if (!rel) continue;
      const target = entityByKey.get(caseInsensitive ? rel.target.toLowerCase() : rel.target);
      if (!target) continue;
      const fk = (rel as any).joinColumn ?? relName + 'Id';
      const fkVal = row[fk] ?? row[relName + 'Id'];
      if (fkVal === undefined || fkVal === null) { row[relName] = null; continue; }
      row[relName] = await d.findOne(target, { id: fkVal });
    }
    return row;
  }

  // --- Per-model proxy ---
  function makeModelProxy(entity: EntitySchema): any {
    return new Proxy({}, {
      get(_t, op: PropertyKey) {
        if (typeof op !== 'string') return undefined;
        return async (args?: any) => {
          const d = await getD();
          const include = args?.include;
          const cleanArgs = include ? { ...args, include: undefined } : args;
          const started = Date.now();
          try {
            const result = await dispatchPrismaOp(
              d,
              { dialect, schema: entity } as any,
              entity.name,
              op as any,
              cleanArgs
            );
            opts.onIntercept?.({ model: entity.name, operation: op, duration: Date.now() - started });
            if (!resolveInc || !include) return result;
            if (Array.isArray(result)) {
              return Promise.all(result.map(r => applyInclude(r, entity, include)));
            }
            return applyInclude(result, entity, include);
          } catch (error) {
            opts.onIntercept?.({ model: entity.name, operation: op, duration: Date.now() - started, error: error as Error });
            throw error;
          }
        };
      },
    });
  }

  // --- Root proxy ---
  return new Proxy({}, {
    get(_t, prop: PropertyKey) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;                          // not thenable
      if (prop === '$connect')    return async () => { await getD(); };
      if (prop === '$disconnect') return async () => {
        const d = globalScope.__mostaPrismaLikeDialect;
        if (d) { await d.disconnect(); globalScope.__mostaPrismaLikeDialect = undefined; }
      };
      if (prop === '$transaction') {
        return async (arg: any) => {
          if (typeof arg === 'function') return arg(this);
          if (Array.isArray(arg)) { const out: any[] = []; for (const p of arg) out.push(await p); return out; }
          return arg;
        };
      }
      const key = caseInsensitive ? prop.toLowerCase() : prop;
      const entity = entityByKey.get(key);
      if (!entity) {
        throw new Error(`[@mostajs/orm-bridge] Unknown model "${prop}" — not found in entities`);
      }
      return makeModelProxy(entity);
    },
  }) as T;
}
