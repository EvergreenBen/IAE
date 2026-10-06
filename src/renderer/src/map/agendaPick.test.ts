import { describe, expect, it } from 'vitest';
import type { AgendaItem } from '@shared/model';
import { FRESH_MS, orderAgenda } from './agendaPick';

const NOW = 1_000_000;
const item = (id: string, priority: number, ageMs: number, blocking?: string[]): { item: AgendaItem } => ({
  item: { id, kind: 'decision', prompt: id, priority, createdAt: NOW - ageMs, status: 'open', nodeId: null, blocking },
});
const order = (list: { item: AgendaItem }[], current: string | null = null, later: string[] = []) =>
  orderAgenda(list, { now: NOW, later, current, blocking: (i) => !!i.blocking?.length }).map((x) => x.item.id);

describe('which question gets the card', () => {
  it('goes by priority when nothing is new', () => {
    expect(order([item('a', 0.5, 60_000), item('b', 0.8, 90_000)])).toEqual(['b', 'a']);
  });

  it('a freshly raised item (what Archie just said) takes the card from an older, higher one', () => {
    expect(order([item('old', 0.9, 60_000), item('new', 0.5, 2_000)], 'old')).toEqual(['new', 'old']);
  });

  it('unless the older one is holding up a builder', () => {
    expect(order([item('old', 0.9, 60_000, ['ada']), item('new', 0.5, 2_000)], 'old')).toEqual(['old', 'new']);
    // A fresh item that also blocks someone is the more pressing news.
    expect(order([item('old', 0.9, 60_000, ['ada']), item('new', 0.5, 2_000, ['kit'])], 'old')).toEqual(['new', 'old']);
  });

  it('the newest of two fresh items leads', () => {
    expect(order([item('first', 0.9, 8_000), item('second', 0.4, 1_000)])).toEqual(['second', 'first']);
  });

  it('once it is no longer fresh, the card that is up stays up', () => {
    const aged = FRESH_MS + 5_000;
    expect(order([item('old', 0.9, 120_000), item('was-new', 0.5, aged)], 'was-new')).toEqual(['was-new', 'old']);
    // ...and with no card up, priority decides again.
    expect(order([item('old', 0.9, 120_000), item('was-new', 0.5, aged)], null)).toEqual(['old', 'was-new']);
  });

  it('"later" sends an item to the back, fresh or not', () => {
    expect(order([item('old', 0.5, 60_000), item('new', 0.9, 1_000)], null, ['new'])).toEqual(['old', 'new']);
  });
});
