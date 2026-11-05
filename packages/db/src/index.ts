// SPDX-License-Identifier: AGPL-3.0-only
export { runMigrations, migrationsDir } from './migrate.js';
export {
  assertPgvectorVersion,
  ensurePinIndex,
  pgvectorAtLeast,
  pinIndexName,
  reportPinReadiness,
  type PinIndexReport,
} from './pin-index.js';
export {
  lintSchema,
  APP_ALLOWED_FUNCTIONS,
  PLATFORM_ONLY_FUNCTIONS,
  INTERNAL_ONLY_FUNCTIONS,
  type LintFinding,
} from './schema-lint.js';
export {
  createPool,
  withTenant,
  readEpochs,
  TenantContextError,
  type EpochCheck,
  type EpochReads,
  type TenantClient,
  type TenantContext,
  type TenantPhase,
  type WithTenantOptions,
} from './tenant.js';
