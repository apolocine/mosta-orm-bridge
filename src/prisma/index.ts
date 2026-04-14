// Prisma sub-module public API
// Usage: import { mostaExtension } from '@mostajs/orm-bridge/prisma'
// Author: Dr Hamid MADANI drmdh@msn.com

export { mostaExtension } from './extension.js';
export { dispatchPrismaOp } from './dispatcher.js';
export { mapPrismaWhere } from './mappers/where.js';
export { mapPrismaOrderBy } from './mappers/orderby.js';
export { createPrismaLikeDb } from './client.js';
export type { CreatePrismaLikeDbOptions } from './client.js';
export type { PrismaBridgeConfig, PrismaOperation, ModelBinding } from './types.js';
