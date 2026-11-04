// SPDX-License-Identifier: AGPL-3.0-only
// pg-boss ships its migration store untyped and without an exports map; only the rollback plan is
// used, by the bootstrap integration test, to downgrade a schema one version.
declare module 'pg-boss/dist/migrationStore.js' {
  export function rollback(schema: string, version: number): string;
}
