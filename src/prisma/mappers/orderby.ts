// Prisma orderBy → @mostajs/orm sort
// Author: Dr Hamid MADANI drmdh@msn.com

import type { SortDirection } from '@mostajs/orm';

/**
 * Convert Prisma `orderBy` to mosta-orm QueryOptions.sort.
 *
 * Prisma accepts :
 *  - { field: 'asc' | 'desc' }
 *  - [{ field: 'asc' }, { other: 'desc' }]
 *  - { field: { sort: 'asc', nulls: 'first' } }  — nulls ignored in v0.1
 *  - { relation: { field: 'asc' } }              — flattened to dotted path
 */
export function mapPrismaOrderBy(orderBy: unknown): Record<string, SortDirection> | undefined {
  if (!orderBy) return undefined;

  const out: Record<string, SortDirection> = {};

  const entries = Array.isArray(orderBy)
    ? orderBy.flatMap(o => Object.entries(o as Record<string, unknown>))
    : Object.entries(orderBy as Record<string, unknown>);

  for (const [key, val] of entries) {
    if (typeof val === 'string') {
      out[key] = val === 'desc' ? -1 : 1;
    } else if (val && typeof val === 'object') {
      const v = val as { sort?: string };
      if (v.sort === 'asc' || v.sort === 'desc') {
        out[key] = v.sort === 'desc' ? -1 : 1;
      }
      // nested relation: skip for now (not trivial without schema info)
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
