// SPDX-License-Identifier: AGPL-3.0-only
import type { RefusalCode } from '@our-stream/documents';

/** A refusal: the job fails with this neutral code; nothing about the file's content is carried. */
export class Refusal extends Error {
  constructor(public readonly code: RefusalCode) {
    super(code);
    this.name = 'Refusal';
  }
}
