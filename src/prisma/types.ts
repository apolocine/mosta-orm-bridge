// Prisma-specific bridge types
// Author: Dr Hamid MADANI drmdh@msn.com

import type { EntitySchema } from '@mostajs/orm';
import type { BridgeConfig, ModelBinding } from '../core/types.js';

/**
 * Resolve an EntitySchema by model name (case already normalised by caller).
 * Used by nested-write logic to look up the target schema of a relation
 * (e.g. resolve `Post.author` → `User` schema for `connect` / `create`).
 */
export type EntityResolver = (name: string) => EntitySchema | undefined;

export interface PrismaBridgeConfig extends BridgeConfig {
  /** (optional) override default fallback to 'prisma' */
  fallback?: 'source' | 'error';
}

export type PrismaOperation =
  | 'findUnique' | 'findUniqueOrThrow'
  | 'findFirst'  | 'findFirstOrThrow'
  | 'findMany'
  | 'count'
  | 'create'     | 'createMany'
  | 'update'     | 'updateMany'
  | 'upsert'
  | 'delete'     | 'deleteMany'
  | 'aggregate'  | 'groupBy';

export type { ModelBinding };
