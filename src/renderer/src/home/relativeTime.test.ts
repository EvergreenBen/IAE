import { describe, expect, it } from 'vitest';
import { relativeTime, tildify } from './relativeTime';

const NOW = new Date('2026-10-06T12:00:00Z').getTime();
const ago = (ms: number) => relativeTime(NOW - ms, NOW);

describe('relativeTime', () => {
  it('reads like a person would say it', () => {
    expect(ago(10_000)).toBe('Just now');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(5 * 60_000)).toBe('5 minutes ago');
    expect(ago(2 * 3_600_000)).toBe('2 hours ago');
    expect(ago(30 * 3_600_000)).toBe('Yesterday');
    expect(ago(3 * 86_400_000)).toBe('3 days ago');
    expect(ago(14 * 86_400_000)).toBe('2 weeks ago');
  });

  it('never says the future', () => {
    expect(relativeTime(NOW + 5000, NOW)).toBe('Just now');
  });
});

describe('tildify', () => {
  it('folds the home directory', () => {
    expect(tildify('/Users/ben/Projects/x')).toBe('~/Projects/x');
    expect(tildify('/opt/x')).toBe('/opt/x');
  });
});
