// Prisma-specific bridge types
// Author: Dr Hamid MADANI drmdh@msn.com

import type { BridgeConfig, ModelBinding } from '../core/types.js';

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
