// Prisma dispatcher : route Prisma operations to @mostajs/orm dialect methods
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later

import type { IDialect, EntitySchema, FilterQuery } from '@mostajs/orm';
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
      return dispatchAggregate(dialect, schema, where, a as unknown as PrismaAggregateArgs);

    case 'groupBy':
      return dispatchGroupBy(dialect, schema, where, a as unknown as PrismaGroupByArgs);

    default:
      throw new Error(
        `Prisma operation "${operation}" not yet supported by @mostajs/orm-bridge. Open an issue with your use case.`
      );
  }
}

// ============================================================
// Aggregate / GroupBy — Prisma → mosta-orm pipeline
// ============================================================

type PrismaAggregateArgs = {
  _count?: true | Record<string, boolean>;
  _sum?:   Record<string, boolean>;
  _avg?:   Record<string, boolean>;
  _min?:   Record<string, boolean>;
  _max?:   Record<string, boolean>;
  orderBy?: unknown;
  take?: number;
  skip?: number;
};
type PrismaGroupByArgs = PrismaAggregateArgs & {
  by: string | string[];
  having?: unknown;
};

/**
 * Build a mosta-orm `$group` stage field map from Prisma-style accumulators.
 * Returns both the group object and an ordered list of output keys so we can
 * reshape the raw result back to Prisma's nested `_count/_sum/...` shape.
 */
function buildAccumulators(a: PrismaAggregateArgs): {
  groupFields: Record<string, unknown>;
  outputMap: Array<{ key: string; op: '_count'|'_sum'|'_avg'|'_min'|'_max'; field: string; scalar: boolean }>;
} {
  const groupFields: Record<string, unknown> = {};
  const outputMap: Array<{ key: string; op: any; field: string; scalar: boolean }> = [];

  // _count — either `true` (total rows) or per-field non-null counts
  if (a._count === true) {
    groupFields['__count_all'] = { $count: true };
    outputMap.push({ key: '__count_all', op: '_count', field: '_all', scalar: true });
  } else if (a._count && typeof a._count === 'object') {
    for (const [f, on] of Object.entries(a._count)) {
      if (!on) continue;
      const k = `__count_${f}`;
      // mosta-orm accumulator for per-field count : use $sum of 1 for rows where field is non-null
      // Fallback : use $count for total (best-effort) — documented limitation for v0.2.1
      groupFields[k] = { $count: true };
      outputMap.push({ key: k, op: '_count', field: f, scalar: false });
    }
  }

  for (const op of ['_sum', '_avg', '_min', '_max'] as const) {
    const spec = a[op];
    if (!spec) continue;
    const mostaOp = op === '_sum' ? '$sum' : op === '_avg' ? '$avg' : op === '_min' ? '$min' : '$max';
    for (const [f, on] of Object.entries(spec)) {
      if (!on) continue;
      const k = `${op}_${f}`;
      groupFields[k] = { [mostaOp]: f };
      outputMap.push({ key: k, op, field: f, scalar: false });
    }
  }

  return { groupFields, outputMap };
}

function reshapeAccumulators(row: Record<string, unknown>, outputMap: ReturnType<typeof buildAccumulators>['outputMap']): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const { key, op, field, scalar } of outputMap) {
    if (scalar) {
      // _count: true → flat number on the aggregate result
      out[op] = row[key] ?? 0;
      continue;
    }
    out[op] = out[op] ?? {};
    out[op][field] = row[key] ?? (op === '_count' ? 0 : null);
  }
  return out;
}

async function dispatchAggregate(
  dialect: IDialect,
  schema: EntitySchema,
  where: FilterQuery,
  a: PrismaAggregateArgs
): Promise<unknown> {
  const { groupFields, outputMap } = buildAccumulators(a);
  if (outputMap.length === 0) {
    // `aggregate({ where })` with no accumulator → Prisma returns {}.
    return {};
  }
  const stages: any[] = [];
  if (where && Object.keys(where).length) stages.push({ $match: where });
  stages.push({ $group: { _by: null, ...groupFields } });

  const rows = await dialect.aggregate<Record<string, unknown>>(schema, stages);
  // aggregate returns a SINGLE object (not an array) in Prisma semantics
  const first = rows[0] ?? {};
  return reshapeAccumulators(first, outputMap);
}

async function dispatchGroupBy(
  dialect: IDialect,
  schema: EntitySchema,
  where: FilterQuery,
  a: PrismaGroupByArgs
): Promise<unknown[]> {
  const by = Array.isArray(a.by) ? a.by : [a.by];
  if (by.length === 0) throw new Error('[bridge] groupBy requires a non-empty `by` field');
  if (by.length > 1) {
    // mosta-orm currently groups by a single field. Multi-field groupBy falls
    // back to concatenating values with a separator ; consumers that need
    // strict multi-column grouping should open an issue (or we relax the
    // upstream AggregateGroupStage._by type in @mostajs/orm).
    throw new Error(
      `[bridge] groupBy on ${by.length} fields not yet supported — mosta-orm AggregateGroupStage._by accepts a single field. ` +
      `Group by "${by[0]}" only, or concatenate upstream.`
    );
  }
  const byField = by[0];
  const { groupFields, outputMap } = buildAccumulators(a);

  const stages: any[] = [];
  if (where && Object.keys(where).length) stages.push({ $match: where });
  stages.push({ $group: { _by: byField, [byField]: byField, ...groupFields } });
  if (a.orderBy) {
    // Best-effort : pass through if it's a plain { field: 'asc'|'desc' }
    const ob = a.orderBy as any;
    if (ob && typeof ob === 'object' && !Array.isArray(ob)) {
      const sort: Record<string, 1 | -1> = {};
      for (const [k, v] of Object.entries(ob)) sort[k] = v === 'desc' ? -1 : 1;
      if (Object.keys(sort).length) stages.push({ $sort: sort });
    }
  }
  if (typeof a.take === 'number') stages.push({ $limit: a.take });

  const rows = await dialect.aggregate<Record<string, unknown>>(schema, stages);
  return rows.map(r => ({
    [byField]: r[byField] ?? r['_by'] ?? r['_id'],
    ...reshapeAccumulators(r, outputMap),
  }));
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
