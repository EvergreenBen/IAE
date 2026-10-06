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
  it('shows everything for a bare slash', () => {
    expect(filterCommands(cmds, '')).toHaveLength(4);
  });
  it('scores word starts above scattered letters', () => {
    expect(fuzzyScore('sr', 'security-review')).toBeGreaterThan(fuzzyScore('sr', 'simplify-rest'.replace('-', 'x')));
  });
});
