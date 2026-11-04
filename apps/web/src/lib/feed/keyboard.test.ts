// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { feedKeyAction, stepIndex } from './keyboard.js';

const on = { singleKeyShortcuts: true };
const off = { singleKeyShortcuts: false };
const body = (key: string) => ({ key, targetTag: 'body' });

describe('feedKeyAction', () => {
  it('maps arrows and Space regardless of the shortcut setting', () => {
    expect(feedKeyAction(body('ArrowDown'), off)).toBe('next');
    expect(feedKeyAction(body('ArrowUp'), off)).toBe('prev');
    expect(feedKeyAction(body(' '), off)).toBe('togglePlay');
  });
  it('maps J/K/C/M only while single-key shortcuts are enabled (WCAG 2.1.4)', () => {
    expect(feedKeyAction(body('j'), on)).toBe('next');
    expect(feedKeyAction(body('K'), on)).toBe('prev');
    expect(feedKeyAction(body('c'), on)).toBe('toggleCaptions');
    expect(feedKeyAction(body('m'), on)).toBe('toggleMute');
    for (const k of ['j', 'k', 'c', 'm']) expect(feedKeyAction(body(k), off)).toBeNull();
  });
  it('ignores keys typed into form fields and editable regions', () => {
    expect(feedKeyAction({ key: 'j', targetTag: 'input' }, on)).toBeNull();
    expect(feedKeyAction({ key: 'ArrowDown', targetTag: 'textarea' }, on)).toBeNull();
    expect(feedKeyAction({ key: ' ', targetTag: 'div', isEditable: true }, on)).toBeNull();
  });
  it('does not double-handle Space on a focused button or link', () => {
    expect(feedKeyAction({ key: ' ', targetTag: 'button' }, on)).toBeNull();
    expect(feedKeyAction({ key: ' ', targetTag: 'a' }, on)).toBeNull();
    expect(feedKeyAction({ key: 'ArrowDown', targetTag: 'button' }, on)).toBe('next');
  });
  it('ignores modified keys so browser shortcuts keep working', () => {
    expect(feedKeyAction({ ...body('j'), metaKey: true }, on)).toBeNull();
    expect(feedKeyAction({ ...body('ArrowDown'), ctrlKey: true }, on)).toBeNull();
  });
  it('returns null for unmapped keys', () => {
    expect(feedKeyAction(body('x'), on)).toBeNull();
    expect(feedKeyAction(body('Enter'), on)).toBeNull();
  });
});

describe('stepIndex', () => {
  it('clamps at both ends', () => {
    expect(stepIndex(0, 'prev', 3)).toBe(0);
    expect(stepIndex(2, 'next', 3)).toBe(2);
    expect(stepIndex(1, 'next', 3)).toBe(2);
    expect(stepIndex(1, 'prev', 3)).toBe(0);
    expect(stepIndex(5, 'next', 0)).toBe(0);
  });
});
