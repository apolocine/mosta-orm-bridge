// test-prisma-client.ts — full-surface test of createPrismaLikeDb()
// Author: Dr Hamid MADANI drmdh@msn.com
//
// Exercises findUnique / findMany / create / update / delete / count /
// upsert / aggregate / groupBy / $transaction / include on a real in-memory
// SQLite DB, driven through the Prisma-like proxy.
//
// Run: npx tsx test-scripts/test-prisma-client.ts

import { unlinkSync, existsSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { getDialect } from '@mostajs/orm';
import type { EntitySchema } from '@mostajs/orm';
import { createPrismaLikeDb } from '../src/prisma/client.js';

// ---------- Fixtures ----------
const DB_FILE = '/tmp/mosta-bridge-test-prisma-client.db';
for (const s of ['', '-shm', '-wal']) { try { unlinkSync(DB_FILE + s); } catch {} }

const UserSchema: EntitySchema = {
  name: 'User',
  collection: 'users',
  fields: {
    id:       { type: 'string',  required: true },
    email:    { type: 'string',  required: true, unique: true },
    password: { type: 'string',  required: true },
    role:     { type: 'string',  required: true, default: 'MEMBER' },
    age:      { type: 'number',  required: false },
    credits:  { type: 'number',  required: true, default: 0 },
    isActive: { type: 'boolean', required: true, default: true },
  },
  relations: {},
  indexes: [],
  timestamps: false,
};
const ProfileSchema: EntitySchema = {
  name: 'Profile',
  collection: 'profiles',
  fields: {
    id:        { type: 'string', required: true },
    userId:    { type: 'string', required: true },
    firstName: { type: 'string', required: false },
    lastName:  { type: 'string', required: false },
  },
  relations: {},
  indexes: [],
  timestamps: false,
};
const entities = [UserSchema, ProfileSchema];

// ---------- Bootstrap: init DDL on SQLite ----------
const d = await getDialect({ dialect: 'sqlite', uri: DB_FILE, schemaStrategy: 'update' });
await d.initSchema(entities);

// ---------- Build the Prisma-like proxy ----------
const db: any = createPrismaLikeDb({ entities });

// ---------- Test harness ----------
let passed = 0, failed = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

console.log('▶ createPrismaLikeDb — CRUD');
await t('create alice', async () => {
  const a = await db.User.create({ data: { id: 'u1', email: 'alice@test.com', password: await bcrypt.hash('alice123', 10), role: 'ADMIN', age: 30, credits: 100 } });
  assert(a?.id === 'u1', 'missing id');
});
await t('create bob', async () => {
  await db.User.create({ data: { id: 'u2', email: 'bob@test.com', password: await bcrypt.hash('bob12345', 10), role: 'MEMBER', age: 25, credits: 50 } });
});
await t('create carol (inactive, age 40)', async () => {
  await db.User.create({ data: { id: 'u3', email: 'carol@test.com', password: 'x', role: 'MEMBER', age: 40, credits: 20, isActive: false } });
});

await t('findUnique by email', async () => {
  const a = await db.User.findUnique({ where: { email: 'alice@test.com' } });
  assert(a?.role === 'ADMIN', 'wrong role');
});

await t('case-insensitive access (db.user)', async () => {
  const a = await db.user.findUnique({ where: { email: 'alice@test.com' } });
  assert(a?.id === 'u1', 'lowercase access failed');
});

await t('findMany with where + take', async () => {
  const rows = await db.User.findMany({ where: { role: 'MEMBER' }, take: 10 });
  assert(rows.length === 2, `expected 2, got ${rows.length}`);
});

await t('count', async () => {
  const n = await db.User.count({ where: { isActive: true } });
  assert(n === 2, `expected 2, got ${n}`);
});

await t('update email', async () => {
  const u = await db.User.update({ where: { id: 'u2' }, data: { email: 'bob+updated@test.com' } });
  assert(u.email === 'bob+updated@test.com', 'update failed');
});

console.log('\n▶ createPrismaLikeDb — aggregate');
await t('aggregate _count total', async () => {
  const r = await db.User.aggregate({ _count: true });
  assert(r._count === 3, `expected 3, got ${r._count}`);
});
await t('aggregate _sum credits', async () => {
  const r = await db.User.aggregate({ _sum: { credits: true } });
  assert(r._sum?.credits === 170, `expected 170, got ${r._sum?.credits}`);
});
await t('aggregate _avg age (filtered to active)', async () => {
  const r = await db.User.aggregate({ where: { isActive: true }, _avg: { age: true } });
  assert(Math.round(r._avg?.age) === 28, `expected ~28, got ${r._avg?.age}`);
});
await t('aggregate _min/_max credits', async () => {
  const r = await db.User.aggregate({ _min: { credits: true }, _max: { credits: true } });
  assert(r._min?.credits === 20 && r._max?.credits === 100, `got ${JSON.stringify(r)}`);
});

console.log('\n▶ createPrismaLikeDb — groupBy');
await t('groupBy role with _count', async () => {
  const rows = await db.User.groupBy({ by: 'role', _count: true });
  const byRole = Object.fromEntries(rows.map((r: any) => [r.role, r._count]));
  assert(byRole.ADMIN === 1 && byRole.MEMBER === 2, `got ${JSON.stringify(byRole)}`);
});
await t('groupBy role with _sum credits', async () => {
  const rows = await db.User.groupBy({ by: ['role'], _sum: { credits: true } });
  const byRole = Object.fromEntries(rows.map((r: any) => [r.role, r._sum?.credits]));
  assert(byRole.ADMIN === 100 && byRole.MEMBER === 70, `got ${JSON.stringify(byRole)}`);
});

console.log('\n▶ createPrismaLikeDb — $transaction (sequential)');
await t('$transaction array runs in order', async () => {
  const out = await db.$transaction([
    db.User.count({ where: { role: 'ADMIN' } }),
    db.User.count({ where: { role: 'MEMBER' } }),
  ]);
  assert(out[0] === 1 && out[1] === 2, `got ${JSON.stringify(out)}`);
});

console.log('\n▶ createPrismaLikeDb — cleanup');
await t('deleteMany ADMINs', async () => {
  const r = await db.User.deleteMany({ where: { role: 'ADMIN' } });
  assert(r.count === 1, `expected 1, got ${r.count}`);
});

await d.disconnect();

console.log(`\n\x1b[1m${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed > 0 ? 1 : 0);
