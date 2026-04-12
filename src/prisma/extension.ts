// Prisma Client $extends factory — main public API for Prisma Bridge
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later

import type { PrismaBridgeConfig, PrismaOperation } from './types.js';
import { getOrCreateDialect } from '../core/dialect-registry.js';
import { dispatchPrismaOp } from './dispatcher.js';

/**
 * Build a Prisma Client `$extends` object that intercepts model operations
 * and redirects them to @mostajs/orm for any model listed in `config.models`.
 *
 * @example
 * ```ts
 * import { PrismaClient } from '@prisma/client';
 * import { mostaExtension } from '@mostajs/orm-bridge/prisma';
 *
 * const prisma = new PrismaClient({ datasourceUrl: 'sqlite::memory:' })
 *   .$extends(mostaExtension({
 *     models: {
 *       AuditLog: { dialect: 'mongodb', url: process.env.MONGO_URL },
 *       Inventory: { dialect: 'oracle',  url: process.env.ORACLE_URL },
 *     },
 *   }));
 *
 * // prisma.auditLog.findMany() → executed by @mostajs/orm on MongoDB
 * // prisma.user.findMany()     → still handled by Prisma default engine (if not mapped)
 * ```
 */
export function mostaExtension(config: PrismaBridgeConfig) {
  const fallback = config.fallback ?? 'source';

  /**
   * Return type is deliberately `any` because the structural shape matches
   * Prisma's `defineExtension` input without requiring a hard import
   * of @prisma/client types (optional peer dependency).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extension: any = {
    name: 'mosta-orm-bridge',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: {
          model: string;
          operation: string;
          args: Record<string, unknown> | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          query: (a: any) => Promise<any>;
        }) {
          const binding = model ? config.models[model] : undefined;

          if (!binding) {
            if (fallback === 'error') {
              throw new Error(
                `[@mostajs/orm-bridge] Model "${model}" is not mapped to a mosta-orm dialect. ` +
                `Add it to config.models, or set fallback: 'source' to let Prisma handle it.`
              );
            }
            return query(args);  // let Prisma handle the query normally
          }

          const started = Date.now();
          try {
            const dialect = await getOrCreateDialect(binding);
            const result = await dispatchPrismaOp(
              dialect, binding, model, operation as PrismaOperation, args
            );
            config.onIntercept?.({
              source: 'prisma',
              model,
              operation,
              dialect: binding.dialect,
              duration: Date.now() - started,
            });
            return result;
          } catch (err) {
            config.onIntercept?.({
              source: 'prisma',
              model,
              operation,
              dialect: binding.dialect,
              duration: Date.now() - started,
              error: err as Error,
            });
            throw err;
          }
        },
      },
    },
  };

  return extension;
}
