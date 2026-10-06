import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem, Decision } from '../../shared/model';
import { Agenda, MAX_OPEN, type AgendaSink } from './agenda';

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

  it('records answered decisions and closes the item', () => {
    const { agenda, decisions } = setup();
    const q = agenda.ask({ prompt: 'Cookie sessions or tokens?', kind: 'decision', nodeId: 'api-auth' });
    const idea = agenda.ask({ prompt: 'Add search?', kind: 'idea' });
    expect(agenda.answer(q.id, 'Tokens')?.status).toBe('answered');
    agenda.answer(idea.id, 'Later');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ title: 'Tokens', rationale: 'Cookie sessions or tokens?', nodeId: 'api-auth' });
    expect(agenda.answer(q.id, 'again')).toBeNull();
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
