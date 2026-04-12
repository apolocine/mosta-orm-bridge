// Prisma dispatcher : route Prisma operations to @mostajs/orm dialect methods
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later

import type { IDialect, EntitySchema } from '@mostajs/orm';
import type { ModelBinding } from '../core/types.js';
import type { PrismaOperation } from './types.js';
import { mapPrismaWhere } from './mappers/where.js';
import { mapPrismaOrderBy } from './mappers/orderby.js';
import { modelToCollection } from '../utils/case-conversion.js';

/**
 * Execute a Prisma operation on a mosta-orm dialect.
 * Returns data shaped to match Prisma's expected return contract.
 *
 * Requires `binding.schema` to be set — if absent, builds a minimal
 * schema from the model name (best-effort; may fail on exotic fields).
 */
export async function dispatchPrismaOp(
  dialect: IDialect,
  binding: ModelBinding,
  modelName: string,
  operation: PrismaOperation,
  args: Record<string, unknown> | undefined
): Promise<unknown> {
  const schema = resolveSchema(binding, modelName);
  const a = args ?? {};

  const where   = 'where'   in a ? mapPrismaWhere(a.where) : {};
  const sort    = 'orderBy' in a ? mapPrismaOrderBy(a.orderBy) : undefined;
  const limit   = typeof a.take === 'number' ? a.take : undefined;
  const skip    = typeof a.skip === 'number' ? a.skip : undefined;
  const queryOpts = { sort, limit, skip };

  switch (operation) {
    case 'findUnique':
    case 'findFirst':
      return dialect.findOne(schema, where);

    case 'findUniqueOrThrow':
    case 'findFirstOrThrow': {
      const res = await dialect.findOne(schema, where);
      if (!res) throw new Error(`${modelName} not found (where=${JSON.stringify(where)})`);
      return res;
    }

    case 'findMany':
      return dialect.find(schema, where, queryOpts);

    case 'count':
      return dialect.count(schema, where);

    case 'create':
      return dialect.create(schema, (a.data ?? {}) as Record<string, unknown>);

    case 'createMany': {
      const rows = Array.isArray(a.data) ? a.data : [a.data];
      let count = 0;
      for (const row of rows) {
        await dialect.create(schema, row as Record<string, unknown>);
        count++;
      }
      return { count };
    }

    case 'update': {
      const existing = await dialect.findOne<{ id?: string; _id?: string }>(schema, where);
      if (!existing) throw new Error(`${modelName} not found for update`);
      const id = String(existing.id ?? existing._id ?? '');
      return dialect.update(schema, id, a.data as Record<string, unknown>);
    }

    case 'updateMany': {
      const count = await dialect.updateMany(schema, where, a.data as Record<string, unknown>);
      return { count };
    }

    case 'upsert': {
      const existing = await dialect.findOne<{ id?: string; _id?: string }>(schema, where);
      if (existing) {
        const id = String(existing.id ?? existing._id ?? '');
        return dialect.update(schema, id, a.update as Record<string, unknown>);
      }
      return dialect.create(schema, a.create as Record<string, unknown>);
    }

    case 'delete': {
      const existing = await dialect.findOne<{ id?: string; _id?: string }>(schema, where);
      if (!existing) throw new Error(`${modelName} not found for delete`);
      const id = String(existing.id ?? existing._id ?? '');
      await dialect.delete(schema, id);
      return existing;
    }

    case 'deleteMany': {
      const count = await dialect.deleteMany(schema, where);
      return { count };
    }

    case 'aggregate':
    case 'groupBy':
    default:
      throw new Error(
        `Prisma operation "${operation}" not yet supported by @mostajs/orm-bridge v0.1. Planned for v0.2.0.`
      );
  }
}

/**
 * Resolve the EntitySchema for this model.
 * Prefers binding.schema ; else constructs a permissive minimal schema.
 */
function resolveSchema(binding: ModelBinding, modelName: string): EntitySchema {
  if (binding.schema) return binding.schema;

  // Minimal permissive schema — useful for read-only / pass-through use cases
  return {
    name: modelName,
    collection: binding.collection ?? modelToCollection(modelName),
    fields: {},
    relations: {},
    indexes: [],
    timestamps: false,
  };
}
