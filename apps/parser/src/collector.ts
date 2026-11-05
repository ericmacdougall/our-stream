// SPDX-License-Identifier: AGPL-3.0-only
import {
  hasNul,
  normalizeParagraph,
  type Block,
  type Locator,
  type ParseLimits,
} from '@our-stream/documents';
import { Refusal } from './errors.js';

/** Accumulates blocks under the text and block budgets; refuses NUL characters. */
export class Collector {
  readonly blocks: Block[] = [];
  private bytes = 0;
  constructor(private readonly limits: ParseLimits) {}

  add(text: string, locator: Locator, extra: { heading?: boolean; level?: number } = {}): void {
    if (hasNul(text)) throw new Refusal('nul_bytes');
    const t = normalizeParagraph(text);
    if (!t) return;
    this.bytes += Buffer.byteLength(t, 'utf8');
    if (this.bytes > this.limits.maxTextBytes) throw new Refusal('text_too_large');
    if (this.blocks.length >= this.limits.maxBlocks) throw new Refusal('block_limit');
    const b: Block = { text: t, locator };
    if (extra.heading) {
      b.heading = true;
      if (extra.level !== undefined) b.level = extra.level;
    }
    this.blocks.push(b);
  }

  get textBytes(): number {
    return this.bytes;
  }
}
