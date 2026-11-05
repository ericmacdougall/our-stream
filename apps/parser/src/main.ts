// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir } from 'node:fs/promises';
import { ParserService } from './service.js';

const slotDir = process.env['PARSER_SLOT_DIR'] ?? '/slot';
const ctlDir = process.env['PARSER_CTL_DIR'] ?? '/ctl';
await mkdir(slotDir, { recursive: true }).catch(() => undefined);
await mkdir(ctlDir, { recursive: true }).catch(() => undefined);

const log = (o: object, msg: string) => console.error(JSON.stringify({ level: 'info', msg, ...o }));
const svc = new ParserService({ slotDir, ctlDir, log });
await svc.start();
log({ slotDir, ctlDir }, 'parser started');
const stop = () => {
  svc.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
