// dialect-registry.ts
// Lazy-initializes and caches mosta-orm dialects per model binding.
// Author: Dr Hamid MADANI drmdh@msn.com

import { getDialect, type IDialect, type ConnectionConfig } from '@mostajs/orm';
import type { ModelBinding } from './types.js';

const cache = new Map<string, Promise<IDialect>>();
const schemasInit = new Set<string>();  // key = dialectKey + schema.name

/**
 * Get (or create) a dialect instance for the given binding.
 * Caches by URI so the same connection is reused across calls.
 * Also lazily runs initSchema for each schema registered on the binding.
 */
export async function getOrCreateDialect(binding: ModelBinding): Promise<IDialect> {
  const key = cacheKey(binding);

  if (!cache.has(key)) {
    cache.set(key, initDialect(binding));
  }

  let dialect: IDialect;
  try {
    dialect = await cache.get(key)!;
  } catch (err) {
    cache.delete(key);
    throw err;
  }

  // Idempotent schema init : run once per (connection, schema)
  if (binding.schema) {
    const schemaKey = key + '::' + binding.schema.name;
    if (!schemasInit.has(schemaKey)) {
      await dialect.initSchema([binding.schema]);
      schemasInit.add(schemaKey);
    }
  }

  return dialect;
}

async function initDialect(binding: ModelBinding): Promise<IDialect> {
  const config: ConnectionConfig = binding.connection ?? {
    dialect: binding.dialect,
    uri: binding.url ?? '',
  };
  if (!config.dialect) config.dialect = binding.dialect;

  const dialect = await getDialect(config);
  return dialect;
}

function cacheKey(b: ModelBinding): string {
  return `${b.dialect}::${b.url ?? b.connection?.uri ?? 'custom-conn'}`;
}

/** Close all cached dialects (useful for tests/graceful shutdown) */
export async function disposeAllDialects(): Promise<void> {
  const entries = [...cache.values()];
  cache.clear();
  schemasInit.clear();
  const dialects = await Promise.all(entries.map(p => p.catch(() => null)));
  await Promise.all(
    dialects
      .filter((d): d is IDialect => d !== null)
      .map(d => d.disconnect().catch(() => null))
  );
}
