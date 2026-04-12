// Prisma where clause → @mostajs/orm FilterQuery
// Author: Dr Hamid MADANI drmdh@msn.com

import type { FilterQuery, FilterOperator } from '@mostajs/orm';

/**
 * Convert Prisma `where` argument into mosta-orm FilterQuery.
 *
 * Supported :
 *  - equals: { field: value } or { field: { equals: value } }
 *  - Basic comparison : { gt, gte, lt, lte, not, in, notIn }
 *  - String ops : { contains, startsWith, endsWith, mode: 'insensitive' }
 *  - Logical : AND, OR, NOT
 *  - Nested : { relation: { field: value } } — flattened to dotted path (best effort)
 *
 * Not supported (v0.1) :
 *  - has, hasSome, hasEvery (array membership)
 *  - path/JSON filters
 *  - Relation filters with complex nesting
 */
export function mapPrismaWhere(where: unknown): FilterQuery {
  if (!where || typeof where !== 'object') return {};
  const out: FilterQuery = {};

  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'AND') {
      const arr = Array.isArray(value) ? value : [value];
      out.$and = arr.map(v => mapPrismaWhere(v));
      continue;
    }
    if (key === 'OR') {
      const arr = Array.isArray(value) ? value : [value];
      out.$or = arr.map(v => mapPrismaWhere(v));
      continue;
    }
    if (key === 'NOT') {
      // Best-effort: use $and with inverted ops — simplified to shallow
      const arr = Array.isArray(value) ? value : [value];
      for (const v of arr) {
        const inverted = mapPrismaWhere(v);
        for (const [field, condition] of Object.entries(inverted)) {
          if (field.startsWith('$')) continue;
          out[field] = negateCondition(condition);
        }
      }
      continue;
    }

    out[key] = mapValueOrCondition(value);
  }

  return out;
}

function mapValueOrCondition(value: unknown): unknown {
  // Primitive → equals
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }

  // Array — could be $in implicit (some Prisma patterns)
  if (Array.isArray(value)) return value;

  if (value && typeof value === 'object') {
    return mapOperatorObject(value as Record<string, unknown>);
  }

  return value;
}

function mapOperatorObject(obj: Record<string, unknown>): FilterOperator | unknown {
  const op: FilterOperator = {};

  if ('equals' in obj) op.$eq = obj.equals;
  if ('not'    in obj) op.$ne = obj.not;
  if ('gt'     in obj) op.$gt = obj.gt;
  if ('gte'    in obj) op.$gte = obj.gte;
  if ('lt'     in obj) op.$lt = obj.lt;
  if ('lte'    in obj) op.$lte = obj.lte;
  if ('in'     in obj) op.$in = obj.in as unknown[];
  if ('notIn'  in obj) op.$nin = obj.notIn as unknown[];

  // String operators → regex
  const caseInsensitive = (obj.mode === 'insensitive');
  if ('contains' in obj) {
    op.$regex = escapeRegex(String(obj.contains));
    if (caseInsensitive) op.$regexFlags = 'i';
  }
  if ('startsWith' in obj) {
    op.$regex = '^' + escapeRegex(String(obj.startsWith));
    if (caseInsensitive) op.$regexFlags = 'i';
  }
  if ('endsWith' in obj) {
    op.$regex = escapeRegex(String(obj.endsWith)) + '$';
    if (caseInsensitive) op.$regexFlags = 'i';
  }

  // If no operator keys matched, return original (probably a nested relation filter)
  if (Object.keys(op).length === 0) {
    return obj;
  }

  return op;
}

function negateCondition(condition: unknown): unknown {
  if (typeof condition === 'object' && condition !== null) {
    // Best-effort swap : $eq ↔ $ne, $in ↔ $nin, $gt ↔ $lte, $gte ↔ $lt
    const c = condition as FilterOperator;
    const n: FilterOperator = {};
    if ('$eq'  in c) n.$ne  = c.$eq;
    if ('$ne'  in c) n.$eq  = c.$ne;
    if ('$in'  in c) n.$nin = c.$in;
    if ('$nin' in c) n.$in  = c.$nin;
    if ('$gt'  in c) n.$lte = c.$gt;
    if ('$gte' in c) n.$lt  = c.$gte;
    if ('$lt'  in c) n.$gte = c.$lt;
    if ('$lte' in c) n.$gt  = c.$lte;
    return n;
  }
  return { $ne: condition };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
