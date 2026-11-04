// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { listItems } from './lists.js';

describe('listItems', () => {
  it('accepts the contract shape { items } and the bare array the API emits', () => {
    expect(listItems<number>({ items: [1, 2] })).toEqual([1, 2]);
    expect(listItems<number>([3, 4])).toEqual([3, 4]);
  });
  it('turns anything else into an empty list instead of crashing a page', () => {
    expect(listItems(undefined)).toEqual([]);
    expect(listItems(null)).toEqual([]);
    expect(listItems({ error: { code: 'forbidden' } })).toEqual([]);
    expect(listItems({ items: 'nope' })).toEqual([]);
    expect(listItems('[]')).toEqual([]);
  });
});
