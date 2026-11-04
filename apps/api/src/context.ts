// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';
import type { Config } from './config.js';
import type { Limiters } from './lib/limits.js';
import type { Mailer } from './lib/mailer.js';
import type { ObjectStore } from './lib/storage.js';

/** Dependencies shared by every route module. */
export interface AppContext {
  config: Config;
  pool: pg.Pool;
  mailer: Mailer;
  store: ObjectStore;
  limits: Limiters;
}
