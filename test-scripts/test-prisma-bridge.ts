// test-prisma-bridge.ts — Integration tests for Prisma Bridge on SQLite :memory:
// Author: Dr Hamid MADANI drmdh@msn.com
// Run: npx tsx test-scripts/test-prisma-bridge.ts
//
// Strategy: no Prisma Client required — we invoke the same dispatcher that
// the $extends layer uses, bypassing Prisma entirely. This isolates the
// bridge logic from Prisma version concerns.

import { getDialect, type EntitySchema } from '@mostajs/orm';
import {
  dispatchPrismaOp,
  mapPrismaWhere,
  mapPrismaOrderBy,
  disposeAllDialects,
  type ModelBinding,
} from '../src/index.js';

// ============================================================
// Test harness
// ============================================================

let pass = 0;
let fail = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) { console.log(`  \u2713 ${msg}`); pass++; }
  else      { console.log(`  \u2717 ${msg}`); fail++; }
}
function section(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m=== ${title} ===\x1b[0m`);
}

// ============================================================
// Fixtures — schemas for the in-memory DB
// ============================================================

const UserSchema: EntitySchema = {
  name: 'User',
  collection: 'users',
  fields: {
    email:    { type: 'string', required: true, unique: true },
    name:     { type: 'string' },
    age:      { type: 'number' },
    role:     { type: 'string', default: 'user' },
    archived: { type: 'boolean', default: false },
  },
  relations: {},
  indexes: [{ fields: { email: 'asc' }, unique: true }],
  timestamps: true,
};

const PostSchema: EntitySchema = {
  name: 'Post',
  collection: 'posts',
  fields: {
    title:   { type: 'string', required: true },
    content: { type: 'text' },
    userId:  { type: 'string' },
  },
  relations: {},
  indexes: [],
  timestamps: true,
};

// ============================================================
// Test runner
// ============================================================

async function run() {
  // ---- Setup : single in-memory SQLite holds all models ----
  // schemaStrategy 'create' forces CREATE TABLE statements
  const dialect = await getDialect({
    dialect: 'sqlite',
    uri: ':memory:',
    schemaStrategy: 'create',
  });
  await dialect.initSchema([UserSchema, PostSchema]);

  const userBinding: ModelBinding = { dialect: 'sqlite', url: ':memory:', schema: UserSchema };
  const postBinding: ModelBinding = { dialect: 'sqlite', url: ':memory:', schema: PostSchema };
  void postBinding;  // reserved for future multi-model tests

  // ---- Group 1 : mapPrismaWhere ----
  section('mapPrismaWhere — operator mapping');
  assert(JSON.stringify(mapPrismaWhere({ age: 30 })) === '{"age":30}',
    'primitive equals passthrough');
  assert(JSON.stringify(mapPrismaWhere({ age: { gt: 18 } })) === '{"age":{"$gt":18}}',
    'gt → $gt');
  assert(JSON.stringify(mapPrismaWhere({ age: { gte: 18, lt: 65 } })) === '{"age":{"$gte":18,"$lt":65}}',
    'gte + lt combined');
  assert(JSON.stringify(mapPrismaWhere({ role: { in: ['admin', 'mod'] } })) === '{"role":{"$in":["admin","mod"]}}',
    'in → $in');
  const contains = mapPrismaWhere({ name: { contains: 'bob', mode: 'insensitive' } });
  assert((contains.name as { $regex: string }).$regex === 'bob' &&
         (contains.name as { $regexFlags: string }).$regexFlags === 'i',
    'contains + insensitive → regex with i flag');
  const andClause = mapPrismaWhere({
    AND: [{ age: { gte: 18 } }, { role: 'admin' }]
  });
  assert(Array.isArray(andClause.$and) && andClause.$and.length === 2,
    'AND → $and array');

  // ---- Group 2 : mapPrismaOrderBy ----
  section('mapPrismaOrderBy — sort mapping');
  assert(JSON.stringify(mapPrismaOrderBy({ age: 'desc' })) === '{"age":-1}',
    'desc → -1');
  assert(JSON.stringify(mapPrismaOrderBy([{ role: 'asc' }, { age: 'desc' }])) ===
    '{"role":1,"age":-1}', 'array orderBy combined');
  assert(mapPrismaOrderBy(undefined) === undefined, 'undefined → undefined');

  // ---- Group 3 : dispatch — create + read ----
  section('dispatch — create + findUnique + findMany');
  const alice = await dispatchPrismaOp(dialect, userBinding, 'User', 'create', {
    data: { email: 'alice@example.com', name: 'Alice', age: 30, role: 'admin' }
  }) as Record<string, unknown>;
  assert(typeof alice.email === 'string', 'create returns the row');
  assert(alice.email === 'alice@example.com', 'email preserved');

  const bob = await dispatchPrismaOp(dialect, userBinding, 'User', 'create', {
    data: { email: 'bob@example.com', name: 'Bob', age: 25, role: 'user' }
  }) as Record<string, unknown>;
  assert(typeof bob.email === 'string', 'second create OK');

  const found = await dispatchPrismaOp(dialect, userBinding, 'User', 'findUnique', {
    where: { email: 'alice@example.com' }
  }) as Record<string, unknown> | null;
  assert(found !== null && found.email === 'alice@example.com',
    'findUnique by email returns alice');

  const all = (await dispatchPrismaOp(dialect, userBinding, 'User', 'findMany', {})) as Record<string, unknown>[];
  assert(Array.isArray(all) && all.length === 2, 'findMany returns 2 users');

  // ---- Group 4 : dispatch — count + filtering + ordering ----
  section('dispatch — count + where + orderBy + take');
  const adultCount = await dispatchPrismaOp(dialect, userBinding, 'User', 'count', {
    where: { age: { gte: 30 } }
  });
  assert(adultCount === 1, 'count with gte filter → 1');

  const adminsByAge = await dispatchPrismaOp(dialect, userBinding, 'User', 'findMany', {
    where: { role: { in: ['admin', 'user'] } },
    orderBy: { age: 'desc' },
    take: 10,
  }) as Record<string, unknown>[];
  assert(adminsByAge.length === 2, 'findMany with filter + orderBy + take');
  assert(adminsByAge[0]!.name === 'Alice',
    'orderBy age desc → Alice (30) first');

  // ---- Group 5 : dispatch — update ----
  section('dispatch — update + updateMany');
  const updated = await dispatchPrismaOp(dialect, userBinding, 'User', 'update', {
    where: { email: 'bob@example.com' },
    data: { age: 26 }
  }) as Record<string, unknown>;
  assert(updated.age === 26, 'update: bob.age now 26');

  const manyRes = await dispatchPrismaOp(dialect, userBinding, 'User', 'updateMany', {
    where: { role: 'user' },
    data: { archived: true }
  }) as { count: number };
  assert(manyRes.count >= 1, 'updateMany returns { count }');

  // ---- Group 6 : dispatch — upsert ----
  section('dispatch — upsert');
  const upserted = await dispatchPrismaOp(dialect, userBinding, 'User', 'upsert', {
    where: { email: 'carol@example.com' },
    create: { email: 'carol@example.com', name: 'Carol', age: 40, role: 'user' },
    update: { age: 99 }
  }) as Record<string, unknown>;
  assert(upserted.email === 'carol@example.com', 'upsert created new Carol');
  assert(upserted.age === 40, 'upsert used create branch');

  const upserted2 = await dispatchPrismaOp(dialect, userBinding, 'User', 'upsert', {
    where: { email: 'carol@example.com' },
    create: { email: 'carol@example.com', name: 'Carol', age: 40 },
    update: { age: 41 }
  }) as Record<string, unknown>;
  assert(upserted2.age === 41, 'upsert used update branch');

  // ---- Group 7 : dispatch — delete + deleteMany ----
  section('dispatch — delete + deleteMany');
  const deleted = await dispatchPrismaOp(dialect, userBinding, 'User', 'delete', {
    where: { email: 'carol@example.com' }
  }) as Record<string, unknown>;
  assert(deleted.email === 'carol@example.com', 'delete returns the deleted row');

  const afterDelete = await dispatchPrismaOp(dialect, userBinding, 'User', 'count', {});
  assert(afterDelete === 2, 'count after delete → 2');

  const delManyRes = await dispatchPrismaOp(dialect, userBinding, 'User', 'deleteMany', {
    where: { archived: true }
  }) as { count: number };
  assert(typeof delManyRes.count === 'number', 'deleteMany returns { count }');

  // ---- Group 8 : findUniqueOrThrow ----
  section('findUniqueOrThrow + createMany');
  let threw = false;
  try {
    await dispatchPrismaOp(dialect, userBinding, 'User', 'findUniqueOrThrow', {
      where: { email: 'nobody@nowhere.com' }
    });
  } catch { threw = true; }
  assert(threw, 'findUniqueOrThrow throws when not found');

  const cm = await dispatchPrismaOp(dialect, userBinding, 'User', 'createMany', {
    data: [
      { email: 'u1@x.com', name: 'U1', age: 1 },
      { email: 'u2@x.com', name: 'U2', age: 2 },
      { email: 'u3@x.com', name: 'U3', age: 3 },
    ]
  }) as { count: number };
  assert(cm.count === 3, 'createMany returns { count: 3 }');

  // ---- Group 9 : fallback safety — unsupported operation ----
  section('unsupported operations');
  let aggThrew = false;
  try {
    await dispatchPrismaOp(dialect, userBinding, 'User', 'aggregate', {});
  } catch (e) { aggThrew = (e as Error).message.includes('not yet supported'); }
  assert(aggThrew, 'aggregate throws with clear v0.2 message');

  // ---- Cleanup ----
  await disposeAllDialects();

  // ---- Summary ----
  console.log(`\n\x1b[1m=== Summary ===\x1b[0m`);
  console.log(`  \x1b[32mPass: ${pass}\x1b[0m`);
  console.log(`  \x1b[31mFail: ${fail}\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('\x1b[31mFATAL:\x1b[0m', e);
  process.exit(1);
});
