// Advanced include — Prisma `include: { relation: true | { where, orderBy, take, skip, select, include } }`
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later
//
// Supports every Prisma include surface area :
//   - `true`                                            → load all (no filter)
//   - `{ where, orderBy, take, skip, select, include }` → filtered load
//   - relation types : one-to-one, many-to-one, one-to-many, many-to-many
//   - nested include (recursive)
//   - select projection applied on the loaded rows

import type { IDialect, EntitySchema, QueryOptions } from '@mostajs/orm';
import { mapPrismaWhere } from './mappers/where.js';
import { mapPrismaOrderBy } from './mappers/orderby.js';
import type { EntityResolver } from './types.js';

type IncludeSpec = true | {
  where?:   unknown;
  orderBy?: unknown;
  take?:    number;
  skip?:    number;
  select?:  Record<string, boolean>;
  include?: Record<string, IncludeSpec>;
};

const idOf = (row: unknown): unknown =>
  row && typeof row === 'object'
    ? ((row as any).id ?? (row as any)._id)
    : undefined;

function specOpts(spec: IncludeSpec): {
  where: Record<string, unknown>;
  queryOpts: QueryOptions;
  select?: Record<string, boolean>;
  includeChildren?: Record<string, IncludeSpec>;
} {
  if (spec === true) {
    return { where: {}, queryOpts: {} };
  }
  const where: Record<string, unknown> = spec.where ? mapPrismaWhere(spec.where) : {};
  const sort  = spec.orderBy ? mapPrismaOrderBy(spec.orderBy) : undefined;
  const limit = typeof spec.take === 'number' ? spec.take : undefined;
  const skip  = typeof spec.skip === 'number' ? spec.skip : undefined;
  return {
    where,
    queryOpts: { sort, limit, skip },
    select: spec.select,
    includeChildren: spec.include,
  };
}

function applySelect<T extends Record<string, unknown>>(row: T, select: Record<string, boolean> | undefined): T {
  if (!select || !row) return row;
  const picked: Record<string, unknown> = {};
  for (const [k, on] of Object.entries(select)) {
    if (on && k in row) picked[k] = (row as any)[k];
  }
  // Always keep the id so downstream joins can resolve
  if ('id' in row && picked.id === undefined) picked.id = (row as any).id;
  return picked as T;
}

/**
 * Resolve `include` on a single row, mutating it with hydrated relations.
 * Calls itself recursively via `applyIncludeMany` / `applyIncludeOne` for
 * nested include shapes.
 */
export async function applyInclude(
  dialect: IDialect,
  row: any,
  parentSchema: EntitySchema,
  include: Record<string, IncludeSpec>,
  resolveEntity: EntityResolver,
): Promise<any> {
  if (!row || !include) return row;

  for (const [relName, spec] of Object.entries(include)) {
    if (!spec) continue;
    const rel = parentSchema.relations?.[relName];
    if (!rel) continue;
    const target = resolveEntity(rel.target);
    if (!target) continue;

    const type = rel.type as string;
    const opts = specOpts(spec);

    if (type === 'many-to-one' || (type === 'one-to-one' && !(rel as any).mappedBy)) {
      // FK typically lives on the parent. BUT : the Prisma→EntitySchema
      // adapter sometimes emits inverse 1:1 as many-to-one without joinColumn
      // (the actual FK being on the target). Detect that case and fall through
      // to the child-side branch.
      const fk = (rel as any).joinColumn ?? relName + 'Id';
      const hasFkOnParent = !!(rel as any).joinColumn || (fk in (parentSchema.fields ?? {}));
      if (hasFkOnParent) {
        const fkVal = row[fk] ?? row[relName + 'Id'];
        if (fkVal === undefined || fkVal === null) { row[relName] = null; continue; }
        const found = await dialect.findOne(target, { id: fkVal, ...opts.where });
        if (found && opts.includeChildren) {
          await applyInclude(dialect, found, target, opts.includeChildren, resolveEntity);
        }
        row[relName] = found ? applySelect(found as Record<string, unknown>, opts.select) : null;
        continue;
      }
      // Inverse side — fall through into the child-side branch below, using
      // the target's back-reference joinColumn.
      const inverse = Object.entries(target.relations ?? {})
        .find(([_, r]) => (r as any).target === parentSchema.name && (r as any).joinColumn);
      if (inverse) {
        const [, invRel] = inverse;
        const invFk = (invRel as any).joinColumn;
        const parentId = idOf(row);
        const found = await dialect.findOne(target, { ...opts.where, [invFk]: parentId });
        if (found && opts.includeChildren) {
          await applyInclude(dialect, found, target, opts.includeChildren, resolveEntity);
        }
        row[relName] = found ? applySelect(found as Record<string, unknown>, opts.select) : null;
        continue;
      }
      row[relName] = null;
      continue;
    }

    if (type === 'one-to-many' || (type === 'one-to-one' && (rel as any).mappedBy)) {
      // FK lives on the child — look up via mappedBy or conventional joinColumn
      const fk = (rel as any).mappedBy
        ? (target.relations?.[(rel as any).mappedBy]?.joinColumn ?? ((rel as any).mappedBy + 'Id'))
        : ((rel as any).joinColumn ?? (parentSchema.name.charAt(0).toLowerCase() + parentSchema.name.slice(1) + 'Id'));

      const parentId = idOf(row);
      const children = await dialect.find(
        target,
        { ...opts.where, [fk]: parentId },
        opts.queryOpts,
      );

      if (opts.includeChildren) {
        for (const c of children as any[]) {
          await applyInclude(dialect, c, target, opts.includeChildren, resolveEntity);
        }
      }

      const shaped = opts.select
        ? (children as any[]).map(c => applySelect(c, opts.select))
        : children;
      row[relName] = type === 'one-to-one' ? (shaped[0] ?? null) : shaped;
      continue;
    }

    if (type === 'many-to-many') {
      await applyManyToManyInclude(dialect, row, parentSchema, relName, rel, target, spec, resolveEntity);
      continue;
    }
  }
  return row;
}

async function applyManyToManyInclude(
  dialect: IDialect,
  row: any,
  parentSchema: EntitySchema,
  relName: string,
  rel: any,
  target: EntitySchema,
  spec: IncludeSpec,
  resolveEntity: EntityResolver,
): Promise<void> {
  const through = rel.through as string | undefined;
  if (!through) {
    row[relName] = [];
    return;
  }
  const parentFk = rel.joinColumn        ?? (parentSchema.name.charAt(0).toLowerCase() + parentSchema.name.slice(1) + 'Id');
  const targetFk = rel.inverseJoinColumn ?? (target.name.charAt(0).toLowerCase() + target.name.slice(1) + 'Id');

  // Junction tables have no `id` column (composite PK only), so we query them
  // via raw SQL rather than dialect.find — which would select `id` by default.
  const anyDialect = dialect as unknown as {
    executeQuery?: <T>(sql: string, params: unknown[]) => Promise<T[]>;
  };
  const parentId = idOf(row);
  let targetIds: unknown[] = [];
  if (anyDialect.executeQuery) {
    const links = await anyDialect.executeQuery<Record<string, unknown>>(
      `SELECT "${targetFk}" FROM "${through}" WHERE "${parentFk}" = ?`,
      [parentId],
    );
    targetIds = links.map(l => l[targetFk]).filter(id => id !== undefined && id !== null);
  }

  if (targetIds.length === 0) {
    row[relName] = [];
    return;
  }

  const opts = specOpts(spec);
  const items = await dialect.find(
    target,
    { ...opts.where, id: { $in: targetIds } },
    opts.queryOpts,
  );

  if (opts.includeChildren) {
    for (const c of items as any[]) {
      await applyInclude(dialect, c, target, opts.includeChildren, resolveEntity);
    }
  }

  row[relName] = opts.select
    ? (items as any[]).map(c => applySelect(c, opts.select))
    : items;
}
