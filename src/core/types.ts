// @mostajs/orm-bridge — Shared core types
// Author: Dr Hamid MADANI drmdh@msn.com
// License: AGPL-3.0-or-later

import type { DialectType, ConnectionConfig, EntitySchema } from '@mostajs/orm';

/**
 * Per-model binding configuration.
 * Tells the bridge which @mostajs/orm dialect backs each foreign-ORM model.
 */
export interface ModelBinding {
  /** Dialect name (e.g. 'postgres', 'mongodb', 'oracle') */
  dialect: DialectType;

  /** Connection URL or URI */
  url?: string;

  /** Full connection config (alternative to url) */
  connection?: ConnectionConfig;

  /** Optional collection/table name override (defaults to snake_case + plural of model name) */
  collection?: string;

  /** Optional EntitySchema pre-built (skip schema inference) */
  schema?: EntitySchema;
}

/** Common bridge configuration shared by all source ORMs */
export interface BridgeConfig {
  /**
   * Map of model name → mosta-orm binding.
   * Models NOT listed here fall back to the source ORM's default engine.
   */
  models: Record<string, ModelBinding>;

  /**
   * Behavior when a model is not mapped :
   *  - 'source' (default): let the source ORM handle the query normally
   *  - 'error': throw an error
   */
  fallback?: 'source' | 'error';

  /**
   * Hook called for every intercepted operation, for logging/metrics.
   */
  onIntercept?: (event: InterceptEvent) => void;
}

export interface InterceptEvent {
  source: string;         // 'prisma' | 'drizzle' | 'typeorm' | ...
  model: string;
  operation: string;
  dialect: DialectType;
  duration?: number;
  error?: Error;
}
