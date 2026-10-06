import { describe, expect, it } from 'vitest';
import { parseSlash, rank, type PaletteItem } from './items';

const noop = () => undefined;
const items: PaletteItem[] = [
  { id: 'cmd:meaning', section: 'commands', title: 'Meaning mode', keywords: 'explain notes', run: noop },
  { id: 'cmd:settings', section: 'commands', title: 'Settings', keywords: 'autonomy models', run: noop },
  { id: 'node:api', section: 'nodes', title: 'API', run: noop },
  { id: 'node:api-auth', section: 'nodes', title: 'Auth', hint: 'API', quiet: true, run: noop },
  { id: 'file:session', section: 'files', title: 'session.ts', hint: 'apps/api/src/auth/', path: 'apps/api/src/auth/session.ts', run: noop },
  { id: 'file:env', section: 'files', title: '.env', hint: 'apps/api/', path: 'apps/api/.env', run: noop },
  { id: 'claude:review', section: 'claude', title: '/review', keywords: 'Review the current changes', run: noop },
];

describe('rank', () => {
  it('shows a short, fixed menu for an empty query (no files, nothing quiet)', () => {
    const groups = rank(items, '');
    expect(groups.map((g) => g.section)).toEqual(['commands', 'nodes', 'claude']);
    expect(groups.find((g) => g.section === 'nodes')!.rows.map((r) => r.item.id)).toEqual(['node:api']);
  });

  it('puts the section with the best match first', () => {
    const groups = rank(items, 'auth');
    expect(groups[0].section).toBe('nodes');
    expect(groups[0].rows[0].item.id).toBe('node:api-auth');
  });

  it('finds files by name and highlights inside the name', () => {
    const groups = rank(items, 'sess');
    const files = groups.find((g) => g.section === 'files')!;
    expect(files.rows[0].item.id).toBe('file:session');
    expect(files.rows[0].titleHits).toEqual([0, 1, 2, 3]);
  });

  it('finds .env', () => {
    expect(rank(items, 'env')[0].rows[0].item.id).toBe('file:env');
  });

  it('matches keywords with a penalty and no highlight', () => {
    const groups = rank(items, 'autonomy');
    expect(groups[0].rows[0].item.id).toBe('cmd:settings');
    expect(groups[0].rows[0].titleHits).toEqual([]);
  });

  it('returns nothing for nonsense', () => {
    expect(rank(items, 'zzqx')).toEqual([]);
  });
});

describe('parseSlash', () => {
  it('splits a command from its arguments', () => {
    expect(parseSlash('/review 142')).toEqual({ name: 'review', args: '142' });
    expect(parseSlash('/rev')).toEqual({ name: 'rev', args: '' });
    expect(parseSlash('/')).toEqual({ name: '', args: '' });
    expect(parseSlash('review')).toBeNull();
  });
});
