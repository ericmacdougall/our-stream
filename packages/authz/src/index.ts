// SPDX-License-Identifier: AGPL-3.0-only
export * from './model.js';
export {
  readerVisible,
  authorAccessible,
  auditorAccessible,
  groupsOf,
  streamRoles,
} from './reference.js';
export {
  readerVisibleSql,
  documentGateSql,
  authorAccessibleSql,
  auditorAccessibleSql,
  type PredicateParams,
} from './sql.js';
export { writeTuple, deleteTuple, AuthzRuleError } from './write-tuples.js';
// The fixture matrix is shared with API-level suites so feed, media and notifications prove the same cells.
export { buildFixture, buildOrg, NOW, USER_NAMES, type FixtureOrg } from './fixture.js';
