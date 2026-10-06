import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, Decision } from '../../shared/model';
import { applyOps, emptyMap } from '../../shared/map';
import { Agenda, anchorNode, MAX_OPEN, type AgendaSink } from './agenda';

function setup(items: AgendaItem[] = []) {
  const events: string[] = [];
  const decisions: Decision[] = [];
  const sink: AgendaSink = {
    upsert: (i) => events.push(`upsert ${i.id}`),
    remove: (id) => events.push(`remove ${id}`),
    decision: (d) => decisions.push(d),
    persist: () => {},
  };
  return { agenda: new Agenda(items, [], sink), events, decisions };
}

describe('anchorNode', () => {
  const map = applyOps(emptyMap(), [
    { op: 'upsertNode', node: { id: 'api', parentId: null } },
    { op: 'upsertNode', node: { id: 'api-auth', parentId: 'api' } },
    { op: 'upsertNode', node: { id: 'api-auth-oauth', parentId: 'api-auth' } },
    { op: 'upsertNode', node: { id: 'web', parentId: null } },
    { op: 'upsertNode', node: { id: 'web-pages', parentId: 'web' } },
  ]);
  it('lifts a deep node to what is visible where the person is looking', () => {
    expect(anchorNode(map, 'api-auth-oauth', null)).toBe('api');
    expect(anchorNode(map, 'api-auth-oauth', 'api')).toBe('api-auth');
    expect(anchorNode(map, 'api-auth-oauth', 'api-auth')).toBe('api-auth-oauth');
    expect(anchorNode(map, 'api', 'api')).toBe('api');
  });
  it('outside the current scope, sits no deeper than a top-level node’s child', () => {
    expect(anchorNode(map, 'api-auth-oauth', 'web')).toBe('api-auth');
    expect(anchorNode(map, 'web-pages', 'api')).toBe('web-pages');
    expect(anchorNode(map, 'nope', null)).toBeNull();
    expect(anchorNode(map, null, null)).toBeNull();
  });
});

describe('Agenda', () => {
  it('orders blocking items first, then by priority, then by age', () => {
    vi.useFakeTimers();
    const { agenda } = setup();
    const low = agenda.ask({ prompt: 'low', priority: 0.2 });
    vi.advanceTimersByTime(10);
    const high = agenda.ask({ prompt: 'high', priority: 0.8 });
    vi.advanceTimersByTime(10);
    const high2 = agenda.ask({ prompt: 'high, newer', priority: 0.8 });
    const blocking = agenda.ask({ prompt: 'blocking', priority: 0.1, blocking: ['ada'] });
    expect(agenda.open().map((i) => i.id)).toEqual([blocking.id, high.id, high2.id, low.id]);
    expect(blocking.priority).toBeGreaterThanOrEqual(0.95);
    vi.useRealTimers();
  });

  it(`keeps at most ${MAX_OPEN} open, pruning the lowest-ranked non-blocking item`, () => {
    const { agenda, events } = setup();
    const blocking = agenda.ask({ prompt: 'blocked', priority: 0, blocking: ['kit'] });
    const items = [0.9, 0.8, 0.7, 0.6, 0.5].map((p) => agenda.ask({ prompt: `p${p}`, priority: p }));
    const open = agenda.open().map((i) => i.id);
    expect(open).toHaveLength(MAX_OPEN);
    expect(open).toContain(blocking.id);
    expect(open).not.toContain(items[4].id);
    expect(events).toContain(`remove ${items[4].id}`);
  });

  it('closes answered items without recording a decision (the lead records it once, in its words)', () => {
    const { agenda, decisions } = setup();
    const q = agenda.ask({ prompt: 'Cookie sessions or tokens?', kind: 'decision', nodeId: 'api-auth' });
    expect(agenda.answer(q.id, 'Tokens')).toMatchObject({ status: 'answered', answer: 'Tokens' });
    expect(decisions).toHaveLength(0);
    expect(agenda.answer(q.id, 'again')).toBeNull();
    agenda.decide({ title: 'Sessions use tokens', rationale: 'Mobile clients', nodeId: 'api-auth' });
    expect(decisions).toHaveLength(1);
  });

  it('resolves waiters on answer, dismissal and timeout', async () => {
    const { agenda } = setup();
    const a = agenda.ask({ prompt: 'a', blocking: ['ada'] });
    const b = agenda.ask({ prompt: 'b', blocking: ['kit'] });
    const c = agenda.ask({ prompt: 'c' });
    const wa = agenda.waitFor(a.id, 10_000);
    const wb = agenda.waitFor(b.id, 10_000);
    const wc = agenda.waitFor(c.id, 5);
    agenda.answer(a.id, 'yes');
    agenda.dismiss(b.id);
    expect(await wa).toBe('yes');
    expect(await wb).toBeNull();
    expect(await wc).toBeNull();
    expect(await agenda.waitFor(a.id, 10)).toBe('yes');
  });

  it('a timed-out waiter leaves no listener behind, and the builder can stop blocking', async () => {
    vi.useFakeTimers();
    const { agenda } = setup();
    const item = agenda.ask({ prompt: 'sha?', blocking: ['ada'] });
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const p = agenda.waitFor(item.id, 1000, abort.signal);
    vi.advanceTimersByTime(1000);
    expect(await p).toBeNull();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    agenda.removeBlocker(item.id, 'ada');
    expect(agenda.get(item.id)?.blocking).toEqual([]);
    expect(agenda.get(item.id)?.status).toBe('open');
    vi.useRealTimers();
  });

  it('releases an agent from items it was blocking', () => {
    const { agenda } = setup();
    const q = agenda.ask({ prompt: 'q', blocking: ['ada'] });
    agenda.addBlocker(q.id, 'kit');
    expect(agenda.get(q.id)?.blocking).toEqual(['ada', 'kit']);
    agenda.releaseAgent('ada');
    expect(agenda.get(q.id)?.blocking).toEqual(['kit']);
  });

  it('clears stale blockers on load (builders do not survive a restart)', () => {
    const stale: AgendaItem = { id: 'q-1', kind: 'decision', prompt: 'x', blocking: ['ada'], priority: 0.95, status: 'open', createdAt: 1 };
    const { agenda } = setup([stale]);
    expect(agenda.open()[0].blocking).toEqual([]);
  });
});
