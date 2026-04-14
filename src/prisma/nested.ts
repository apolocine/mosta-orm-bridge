// Nested writes — Prisma → @mostajs/orm
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later
//
// Handles `create / connect / connectOrCreate / createMany / set / disconnect /
// update / updateMany / delete / deleteMany` on relations nested in
// `data.<relation>`. Supports:
//   - relations: one-to-one, many-to-one, one-to-many, many-to-many (via `through`)
//   - `connect: { where: { id } }` AND any declared unique key (single or composite)
//   - rollback is provided by the caller wrapping us in `dialect.$transaction`.
//     If `$transaction` is unavailable, the caller does best-effort compensation.

import type { IDialect, EntitySchema } from '@mostajs/orm';
import { mapPrismaWhere } from './mappers/where.js';
import type { EntityResolver } from './types.js';

export type NestedOp =
  | 'create' | 'createMany'
  | 'connect' | 'connectOrCreate'
  | 'set'    | 'disconnect'
  | 'update' | 'updateMany'
  | 'delete' | 'deleteMany'
  | 'upsert';

export interface NestedEntry {
  /** Relation field name on the parent schema (e.g. "posts") */
  relation: string;
  /** Resolved target schema (caller side : dispatcher has the resolver) */
  target: EntitySchema;
  /** Original parent→target relation definition (type, joinColumn, through, …) */
  rel: any;
  /** Each nested op on that relation */
  ops: Array<{ op: NestedOp; payload: any }>;
}

/** Is this field shape a nested-writes object? (`{ create: ... }`, etc.) */
function looksNested(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length === 0) return false;
  const nestedKeys = new Set([
    'create', 'createMany', 'connect', 'connectOrCreate',
    'set', 'disconnect', 'update', 'updateMany',
    'delete', 'deleteMany', 'upsert',
  ]);
  return keys.every(k => nestedKeys.has(k));
}

/**
 * Split `data` into scalar fields (kept on the parent write) and nested ops.
 * Nested ops are only detected on fields that match a declared relation in
 * the parent schema — unknown nested shapes are left as-is to surface errors.
 */
export function extractNested(
  parent: EntitySchema,
  data: Record<string, unknown> | undefined,
  resolveEntity: EntityResolver,
): { scalarData: Record<string, unknown>; nested: NestedEntry[] } {
  const scalarData: Record<string, unknown> = {};
  const nested: NestedEntry[] = [];
  if (!data) return { scalarData, nested };

  for (const [key, val] of Object.entries(data)) {
    const rel = parent.relations?.[key];
    if (rel && looksNested(val)) {
      const target = resolveEntity(rel.target);
      if (!target) {
        throw new Error(
          `[bridge] Nested write on "${parent.name}.${key}" → unknown target entity "${rel.target}". ` +
          `Is it declared in entities.json / passed to createPrismaLikeDb({ entities })?`
        );
      }
      const ops: NestedEntry['ops'] = [];
      for (const [op, payload] of Object.entries(val as Record<string, unknown>)) {
        ops.push({ op: op as NestedOp, payload });
      }
      nested.push({ relation: key, target, rel, ops });
      continue;
    }
    scalarData[key] = val;
  }
  return { scalarData, nested };
}

// ------------------------------------------------------------------
// Unique-key resolution : id OR any declared unique (single / composite)
// ------------------------------------------------------------------

/**
 * Given a `where` shape like Prisma's `connect.where`, find the unique key
 * (field name(s) + value(s)) that matches. Accepts :
 *   - `{ id: 42 }`                                — primary key
 *   - `{ email: 'a@b.c' }`                        — single field `unique: true`
 *   - `{ tenantId_slug: { tenantId, slug } }`     — Prisma composite form
 *   - `{ tenantId, slug }`                        — flat composite form (best-effort)
 */
export function findUniqueMatch(
  schema: EntitySchema,
  where: Record<string, unknown>,
): FilterShape | null {
  if (!where || typeof where !== 'object') return null;
  const keys = Object.keys(where);
  if (keys.length === 0) return null;

  // 1) id direct
  if (keys.length === 1 && (keys[0] === 'id' || keys[0] === '_id')) {
    return { id: where[keys[0]] };
  }

  // 2) single-field unique
  if (keys.length === 1) {
    const f = keys[0];
    const fieldDef = schema.fields?.[f];
    if (fieldDef?.unique) return { [f]: where[f] };

    // 3) Prisma composite form:  tenantId_slug: { tenantId, slug }
    const combo = (schema.indexes ?? []).find(idx => idx.unique && idx.fields && Object.keys(idx.fields).join('_') === f);
    if (combo && where[f] && typeof where[f] === 'object') {
      const out: FilterShape = {};
      for (const cf of Object.keys(combo.fields)) out[cf] = (where[f] as any)[cf];
      return out;
    }
  }

  // 4) Flat composite : { tenantId, slug } matching one @@unique index
  for (const idx of schema.indexes ?? []) {
    if (!idx.unique || !idx.fields) continue;
    const idxFields = Object.keys(idx.fields);
    if (idxFields.length !== keys.length) continue;
    if (idxFields.every(f => f in where)) {
      const out: FilterShape = {};
      for (const f of idxFields) out[f] = where[f];
      return out;
    }
  }

  return null;
}

type FilterShape = Record<string, unknown>;

/**
 * Resolve `connect: { where }` → the concrete target row. Throws if the
 * target is not found (matches Prisma's "An operation failed because it
 * depends on one or more records that were required but not found").
 */
export async function resolveConnect(
  dialect: IDialect,
  target: EntitySchema,
  where: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const match = findUniqueMatch(target, where);
  if (!match) {
    throw new Error(
      `[bridge] connect on "${target.name}" — no unique key found in where=${JSON.stringify(where)}. ` +
      `Accepted keys : id, any field with { unique: true }, or an @@unique composite index.`
    );
  }
  const row = await dialect.findOne<Record<string, unknown>>(target, match);
  if (!row) {
    throw new Error(
      `[bridge] connect on "${target.name}" — no record matches ${JSON.stringify(match)}`
    );
  }
  return row;
}

// ------------------------------------------------------------------
// Main executor — run nested ops AFTER the parent row is known
// ------------------------------------------------------------------

const idOf = (row: unknown): unknown =>
  row && typeof row === 'object'
    ? ((row as any).id ?? (row as any)._id)
    : undefined;

/**
 * Find the inverse relation : the field on `target` whose relation points
 * back to `parentName` and carries a joinColumn. Used when the adapter
 * mis-types an inverse 1:1 as many-to-one (common Prisma→EntitySchema case).
 */
function findInverseRelation(
  target: EntitySchema,
  parentName: string,
): { name: string; rel: any } | null {
  for (const [name, rel] of Object.entries(target.relations ?? {})) {
    if ((rel as any).target === parentName && (rel as any).joinColumn) {
      return { name, rel };
    }
  }
  return null;
}

/**
 * For many-to-one relations, we also need to attach FK *before* creating
 * the parent. This helper returns any FK updates that must be written on
 * the parent's scalarData.  (Called from the dispatcher's pre-create phase.)
 */
export async function resolveParentFks(
  dialect: IDialect,
  parent: EntitySchema,
  nested: NestedEntry[],
): Promise<Record<string, unknown>> {
  const fkPatch: Record<string, unknown> = {};
  for (const entry of nested) {
    const type = entry.rel.type as string;
    if (type !== 'many-to-one' && type !== 'one-to-one') continue;

    // Detect inverse side : a relation typed many-to-one / one-to-one on the
    // parent may actually be the INVERSE side of a 1:1 where the FK lives on
    // the child. We recognise it when neither `joinColumn` nor a matching
    // `<rel>Id` field exists on the parent schema. In that case we leave the
    // entry untouched so `executeNested` handles it post-create (FK written
    // on the child row, pointing back at the freshly-created parent id).
    const fkField = entry.rel.joinColumn ?? (entry.relation + 'Id');
    const hasFkOnParent = !!entry.rel.joinColumn || (fkField in (parent.fields ?? {}));
    if (!hasFkOnParent) {
      // Mark the relation as "inverse side" so the post-create handler knows
      // to write the FK on the child. Reuse `mappedBy` semantics.
      const inverseRel = findInverseRelation(entry.target, parent.name);
      if (inverseRel) {
        entry.rel = { ...entry.rel, mappedBy: inverseRel.name, type: 'one-to-many' };
      }
      continue;
    }

    for (const { op, payload } of entry.ops) {
      if (op === 'create') {
        const child = await dialect.create(entry.target, payload as Record<string, unknown>);
        fkPatch[fkField] = idOf(child);
      } else if (op === 'connect') {
        const child = await resolveConnect(dialect, entry.target, payload as Record<string, unknown>);
        fkPatch[fkField] = idOf(child);
      } else if (op === 'connectOrCreate') {
        const p = payload as { where: any; create: any };
        const match = findUniqueMatch(entry.target, p.where);
        const existing = match ? await dialect.findOne<Record<string, unknown>>(entry.target, match) : null;
        const child = existing ?? await dialect.create(entry.target, p.create as Record<string, unknown>);
        fkPatch[fkField] = idOf(child);
      } else if (op === 'disconnect') {
        fkPatch[fkField] = null;
      } else {
        throw new Error(
          `[bridge] nested "${op}" on parent-side relation "${parent.name}.${entry.relation}" ` +
          `(${type}) is not supported at pre-create. Did you mean to run it on the owning side?`
        );
      }
    }
    // A parent-side relation has exactly one FK field ; multiple ops would be redundant
    entry.ops = [];
  }
  return fkPatch;
}

/**
 * Execute nested ops once the parent row exists (child-side : one-to-many,
 * many-to-many, or one-to-one with owning side on the child).
 */
export async function executeNested(
  dialect: IDialect,
  parent: EntitySchema,
  parentId: unknown,
  nested: NestedEntry[],
  resolveEntity?: EntityResolver,
): Promise<void> {
  if (parentId === undefined || parentId === null) return;

  for (const entry of nested) {
    if (!entry.ops.length) continue;
    const type = entry.rel.type as string;

    if (type === 'one-to-many' || (type === 'one-to-one' && entry.rel.mappedBy)) {
      await runChildSideOne2Many(dialect, parent, parentId, entry, resolveEntity);
    } else if (type === 'many-to-many') {
      await runManyToMany(dialect, parent, parentId, entry, resolveEntity);
    }
  }
}

// ---- one-to-many / inverse one-to-one ------------------------------

async function runChildSideOne2Many(
  dialect: IDialect,
  parent: EntitySchema,
  parentId: unknown,
  entry: NestedEntry,
  resolveEntity?: EntityResolver,
): Promise<void> {
  const fk = entry.rel.mappedBy
    ? (entry.target.relations?.[entry.rel.mappedBy]?.joinColumn ?? (entry.rel.mappedBy + 'Id'))
    : (entry.rel.joinColumn ?? (parent.name.charAt(0).toLowerCase() + parent.name.slice(1) + 'Id'));

  const createChild = async (item: any) => {
    const childData = { ...item, [fk]: parentId };
    if (!resolveEntity) {
      await dialect.create(entry.target, childData);
      return;
    }
    const { scalarData, nested } = extractNested(entry.target, childData, resolveEntity);
    const fkPatch = await resolveParentFks(dialect, entry.target, nested);
    const child = await dialect.create(entry.target, { ...scalarData, ...fkPatch });
    await executeNested(dialect, entry.target, (child as any).id ?? (child as any)._id, nested, resolveEntity);
  };

  for (const { op, payload } of entry.ops) {
    switch (op) {
      case 'create': {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) await createChild(item);
        break;
      }
      case 'createMany': {
        const p = payload as { data: any[] | any; skipDuplicates?: boolean };
        const items = Array.isArray(p.data) ? p.data : [p.data];
        for (const item of items) await createChild(item);
        break;
      }
      case 'connect': {
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const row = await resolveConnect(dialect, entry.target, w);
          await dialect.update(entry.target, String(idOf(row)), { [fk]: parentId });
        }
        break;
      }
      case 'connectOrCreate': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const match = findUniqueMatch(entry.target, p.where);
          const existing = match ? await dialect.findOne<Record<string, unknown>>(entry.target, match) : null;
          if (existing) {
            await dialect.update(entry.target, String(idOf(existing)), { [fk]: parentId });
          } else {
            await dialect.create(entry.target, { ...p.create, [fk]: parentId });
          }
        }
        break;
      }
      case 'disconnect': {
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const match = findUniqueMatch(entry.target, w);
          if (!match) continue;
          const row = await dialect.findOne<Record<string, unknown>>(entry.target, { ...match, [fk]: parentId });
          if (row) await dialect.update(entry.target, String(idOf(row)), { [fk]: null });
        }
        break;
      }
      case 'set': {
        // clear current children then connect the new set
        await dialect.updateMany(entry.target, { [fk]: parentId }, { [fk]: null });
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const row = await resolveConnect(dialect, entry.target, w);
          await dialect.update(entry.target, String(idOf(row)), { [fk]: parentId });
        }
        break;
      }
      case 'update': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const match = findUniqueMatch(entry.target, p.where);
          if (!match) continue;
          const row = await dialect.findOne<Record<string, unknown>>(entry.target, { ...match, [fk]: parentId });
          if (row) await dialect.update(entry.target, String(idOf(row)), p.data);
        }
        break;
      }
      case 'updateMany': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const w = mapPrismaWhere(p.where);
          await dialect.updateMany(entry.target, { ...w, [fk]: parentId }, p.data);
        }
        break;
      }
      case 'delete': {
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const match = findUniqueMatch(entry.target, w);
          if (!match) continue;
          const row = await dialect.findOne<Record<string, unknown>>(entry.target, { ...match, [fk]: parentId });
          if (row) await dialect.delete(entry.target, String(idOf(row)));
        }
        break;
      }
      case 'deleteMany': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const w = p.where ? mapPrismaWhere(p.where) : {};
          await dialect.deleteMany(entry.target, { ...w, [fk]: parentId });
        }
        break;
      }
      case 'upsert': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const match = findUniqueMatch(entry.target, p.where);
          const existing = match ? await dialect.findOne<Record<string, unknown>>(entry.target, { ...match, [fk]: parentId }) : null;
          if (existing) {
            await dialect.update(entry.target, String(idOf(existing)), p.update);
          } else {
            await dialect.create(entry.target, { ...p.create, [fk]: parentId });
          }
        }
        break;
      }
    }
  }
}

// ---- many-to-many (via `through` junction table) -------------------

async function runManyToMany(
  dialect: IDialect,
  parent: EntitySchema,
  parentId: unknown,
  entry: NestedEntry,
  _resolveEntity?: EntityResolver,
): Promise<void> {
  const through = entry.rel.through as string | undefined;
  if (!through) {
    throw new Error(
      `[bridge] many-to-many relation "${parent.name}.${entry.relation}" requires a \`through\` junction table.`
    );
  }
  // Junction table accessed via a lightweight ad-hoc schema. Field names follow
  // the convention <lowercase(parentName)>Id / <lowercase(targetName)>Id unless
  // joinColumn / inverseJoinColumn overrides are specified.
  const parentFk  = entry.rel.joinColumn        ?? (parent.name.charAt(0).toLowerCase() + parent.name.slice(1) + 'Id');
  const targetFk  = entry.rel.inverseJoinColumn ?? (entry.target.name.charAt(0).toLowerCase() + entry.target.name.slice(1) + 'Id');

  // The junction table is created by @mostajs/orm's initSchema with exactly
  // two columns (parentFk, targetFk) and a composite PK — no surrogate `id`.
  // We must therefore bypass dialect.create() (which always inserts `id`) and
  // use executeRun for link/unlink. Same goes for any "find junction rows"
  // lookup elsewhere in this file.
  const anyDialect = dialect as unknown as {
    executeRun?: (sql: string, params: unknown[]) => Promise<{ changes: number }>;
    executeQuery?: <T>(sql: string, params: unknown[]) => Promise<T[]>;
  };
  if (!anyDialect.executeRun) {
    throw new Error(
      `[bridge] many-to-many nested writes require a dialect that exposes executeRun (SQL). ` +
      `Current dialect "${(dialect as any).dialectType}" does not — open an issue.`
    );
  }

  const link = async (targetId: unknown) => {
    await anyDialect.executeRun!(
      `INSERT OR IGNORE INTO "${through}" ("${parentFk}", "${targetFk}") VALUES (?, ?)`,
      [parentId, targetId],
    );
  };
  const unlink = async (targetId: unknown) => {
    await anyDialect.executeRun!(
      `DELETE FROM "${through}" WHERE "${parentFk}" = ? AND "${targetFk}" = ?`,
      [parentId, targetId],
    );
  };

  for (const { op, payload } of entry.ops) {
    switch (op) {
      case 'create': {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          const child = await dialect.create(entry.target, item);
          await link(idOf(child));
        }
        break;
      }
      case 'createMany': {
        const p = payload as { data: any[] | any };
        const items = Array.isArray(p.data) ? p.data : [p.data];
        for (const item of items) {
          const child = await dialect.create(entry.target, item);
          await link(idOf(child));
        }
        break;
      }
      case 'connect': {
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const row = await resolveConnect(dialect, entry.target, w);
          await link(idOf(row));
        }
        break;
      }
      case 'connectOrCreate': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const match = findUniqueMatch(entry.target, p.where);
          const existing = match ? await dialect.findOne<Record<string, unknown>>(entry.target, match) : null;
          const child = existing ?? await dialect.create(entry.target, p.create);
          await link(idOf(child));
        }
        break;
      }
      case 'disconnect': {
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const match = findUniqueMatch(entry.target, w);
          if (!match) continue;
          const row = await dialect.findOne<Record<string, unknown>>(entry.target, match);
          if (row) await unlink(idOf(row));
        }
        break;
      }
      case 'set': {
        await anyDialect.executeRun!(`DELETE FROM "${through}" WHERE "${parentFk}" = ?`, [parentId]);
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const row = await resolveConnect(dialect, entry.target, w);
          await link(idOf(row));
        }
        break;
      }
      case 'update': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const match = findUniqueMatch(entry.target, p.where);
          if (!match) continue;
          const row = await dialect.findOne<Record<string, unknown>>(entry.target, match);
          if (row) await dialect.update(entry.target, String(idOf(row)), p.data);
        }
        break;
      }
      case 'updateMany': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const w = mapPrismaWhere(p.where);
          await dialect.updateMany(entry.target, w, p.data);
        }
        break;
      }
      case 'delete': {
        const ws = Array.isArray(payload) ? payload : [payload];
        for (const w of ws) {
          const match = findUniqueMatch(entry.target, w);
          if (!match) continue;
          const row = await dialect.findOne<Record<string, unknown>>(entry.target, match);
          if (row) {
            await unlink(idOf(row));
            await dialect.delete(entry.target, String(idOf(row)));
          }
        }
        break;
      }
      case 'deleteMany': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const w = p.where ? mapPrismaWhere(p.where) : {};
          await anyDialect.executeRun!(`DELETE FROM "${through}" WHERE "${parentFk}" = ?`, [parentId]);
          await dialect.deleteMany(entry.target, w);
        }
        break;
      }
      case 'upsert': {
        const ps = Array.isArray(payload) ? payload : [payload];
        for (const p of ps) {
          const match = findUniqueMatch(entry.target, p.where);
          const existing = match ? await dialect.findOne<Record<string, unknown>>(entry.target, match) : null;
          const child = existing
            ? (await dialect.update(entry.target, String(idOf(existing)), p.update), existing)
            : await dialect.create(entry.target, p.create);
          await link(idOf(child));
        }
        break;
      }
    }
  }
}
