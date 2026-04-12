// @mostajs/orm-bridge — Root public API
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later

// --- Shared core ---
export type { BridgeConfig, ModelBinding, InterceptEvent } from './core/types.js';
export { getOrCreateDialect, disposeAllDialects } from './core/dialect-registry.js';
export { modelToCollection, pascalToCamel, toPascalCase } from './utils/case-conversion.js';

// --- Prisma bridge (primary sub-module) ---
// Prefer `import { mostaExtension } from '@mostajs/orm-bridge/prisma'` for
// better tree-shaking and explicit intent.
export {
  mostaExtension,
  dispatchPrismaOp,
  mapPrismaWhere,
  mapPrismaOrderBy,
} from './prisma/index.js';
export type {
  PrismaBridgeConfig,
  PrismaOperation,
} from './prisma/types.js';
