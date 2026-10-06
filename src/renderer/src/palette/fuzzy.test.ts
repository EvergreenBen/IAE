import { describe, expect, it } from 'vitest';
import { fuzzy, fuzzyPath, highlightRuns } from './fuzzy';

const rank = (q: string, items: string[]) =>
  items
    .map((t) => ({ t, m: fuzzy(q, t) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => x.t);

describe('fuzzy', () => {
  it('requires every character in order', () => {
    expect(fuzzy('ath', 'Auth')).not.toBeNull();
    expect(fuzzy('hta', 'Auth')).toBeNull();
    expect(fuzzy('authx', 'Auth')).toBeNull();
  });

  it('matches empty queries with a neutral score', () => {
    expect(fuzzy('', 'Anything')).toEqual({ score: 0, indices: [] });
  });

  it('is case-insensitive', () => {
    expect(fuzzy('AUTH', 'auth')).not.toBeNull();
  });

  it('prefers prefixes and exact matches', () => {
    expect(rank('auth', ['Google OAuth', 'Auth', 'Authorization rules'])).toEqual(['Auth', 'Authorization rules', 'Google OAuth']);
  });

  it('prefers word starts and acronyms', () => {
    expect(rank('wd', ['Weekly Digest', 'Web Pages index', 'shadowed'])[0]).toBe('Weekly Digest');
    expect(rank('rb', ['Recipe Box', 'Rubber', 'curb'])[0]).toBe('Recipe Box');
  });

  it('prefers consecutive runs', () => {
    expect(rank('sess', ['Sessions', 'Search settings'])[0]).toBe('Sessions');
  });

  it('matches multiple terms in any order', () => {
    expect(fuzzy('mode meaning', 'Meaning mode')).not.toBeNull();
    expect(fuzzy('mode xyz', 'Meaning mode')).toBeNull();
  });

  it('rejects scattered letters', () => {
    expect(fuzzy('sess', 'apps/api/src/recipes/scale.ts')).toBeNull();
    expect(fuzzy('sess', 'parse-ingredients.ts')).toBeNull();
    expect(fuzzy('sess', '0002_sessions.sql')).not.toBeNull();
    expect(fuzzy('ath', 'Auth')).not.toBeNull();
  });

  it('reports matched indices', () => {
    expect(fuzzy('ac', 'Auth cookie')!.indices).toEqual([0, 5]);
  });
});

describe('fuzzyPath', () => {
  it('prefers matches in the file name', () => {
    const files = ['apps/api/src/auth/session.ts', 'apps/api/src/search/index.ts', 'apps/api/.env'];
    const ranked = files
      .map((p) => ({ p, m: fuzzyPath('env', p) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score);
    expect(ranked[0].p).toBe('apps/api/.env');
  });

  it('falls back to directories', () => {
    expect(fuzzyPath('auth sess', 'apps/api/src/auth/session.ts')).not.toBeNull();
  });

  it('offsets indices into the full path', () => {
    const m = fuzzyPath('sess', 'apps/api/src/auth/session.ts')!;
    expect(m.indices).toEqual([18, 19, 20, 21]);
  });
});

describe('highlightRuns', () => {
  it('splits text into matched and unmatched runs', () => {
    expect(highlightRuns('Auth', [0, 1])).toEqual([
      ['Au', true],
      ['th', false],
    ]);
  });
});
