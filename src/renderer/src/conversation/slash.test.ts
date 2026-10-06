import { describe, expect, it } from 'vitest';
import { filterCommands, fuzzyScore } from './SlashMenu';

const cmds = [
  { name: 'review', description: 'Review the current changes' },
  { name: 'security-review', description: 'Security review of pending changes' },
  { name: 'init', description: 'Write a CLAUDE.md for this codebase' },
  { name: 'simplify', description: 'Simplify recently changed code' },
];

describe('slash command filter', () => {
  it('ranks prefixes first, then subsequences', () => {
    expect(filterCommands(cmds, 'rev').map((c) => c.name)).toEqual(['review', 'security-review']);
    expect(filterCommands(cmds, 'sr').map((c) => c.name)[0]).toBe('security-review');
    expect(filterCommands(cmds, 'zz')).toEqual([]);
  });
  it('puts prefix and part-prefix matches before substrings and scattered letters', () => {
    const many = [{ name: 'design-revoke', description: 'Revoke a design token' }, { name: 'code-review:review', description: 'Review a PR' }, ...cmds];
    expect(filterCommands(many, 'rev').map((c) => c.name)).toEqual(['review', 'design-revoke', 'security-review', 'code-review:review']);
  });
  it('lists every match, not just the first few', () => {
    const lots = Array.from({ length: 37 }, (_, i) => ({ name: `cmd-${i}`, description: '' }));
    expect(filterCommands(lots, '')).toHaveLength(37);
  });
  it('shows everything for a bare slash', () => {
    expect(filterCommands(cmds, '')).toHaveLength(4);
  });
  it('scores word starts above scattered letters', () => {
    expect(fuzzyScore('sr', 'security-review')).toBeGreaterThan(fuzzyScore('sr', 'simplify-rest'.replace('-', 'x')));
  });
});
