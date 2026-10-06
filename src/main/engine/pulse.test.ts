import { describe, expect, it } from 'vitest';
import { emptyMap } from '../../shared/map';
import type { TurnKind } from './context';
import { BACKOFF_MS, IDLE_BEFORE_PULSE_MS, Pulse } from './pulse';
import type { Workspace } from './workspace';

function setup(opts: { agenda?: number; isNew?: boolean } = {}) {
  let now = 1_000_000;
  const events: { urgent: boolean }[] = [];
  const agenda = Array.from({ length: opts.agenda ?? 0 }, (_, i) => ({ id: `q${i}` }));
  const working: { id: string; name: string }[] = [];
  const ws = {
    isClosed: false,
    presence: 'idle',
    lastUserActivityAt: now,
    info: { isNew: opts.isNew ?? false },
    map: emptyMap(),
    agenda: { open: () => agenda },
    hasEvents: (urgentOnly = false) => (urgentOnly ? events.some((e) => e.urgent) : events.length > 0),
  };
  const sent: [TurnKind, string][] = [];
  const lead = {
    busy: false,
    speechEndsAt: 0,
    send: (kind: TurnKind, body: string) => {
      sent.push([kind, body]);
      events.length = 0;
    },
  };
  const pulse = new Pulse({ ws: ws as unknown as Workspace, lead, working: () => working, now: () => now });
  return {
    pulse,
    ws,
    lead,
    sent,
    events,
    agenda,
    working,
    advance: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

describe('Pulse', () => {
  it('stays quiet when nothing is pending', () => {
    const t = setup();
    t.advance(IDLE_BEFORE_PULSE_MS + 1);
    expect(t.pulse.tick()).toBeNull();
  });

  it('raises a question the lead has not had a turn with, once', () => {
    const t = setup({ agenda: 1 });
    t.advance(IDLE_BEFORE_PULSE_MS - 1000);
    expect(t.pulse.tick()).toBeNull();
    t.advance(1000);
    expect(t.pulse.tick()).toBe('pulse');
    expect(t.sent[0][1]).toMatch(/hasn't been raised/);
    // Same question still open: no repeat, however long the quiet lasts.
    t.advance(BACKOFF_MS[2] * 3);
    expect(t.pulse.tick()).toBeNull();
  });

  it("doesn't nudge about a question the lead itself just asked", () => {
    const t = setup({ agenda: 1 });
    t.pulse.turnEnded('user');
    t.advance(IDLE_BEFORE_PULSE_MS * 5);
    expect(t.pulse.pending()).toBeNull();
    expect(t.pulse.tick()).toBeNull();
  });

  it('gives builders at work one nudge, even after a user turn', () => {
    const t = setup();
    t.working.push({ id: 'ada', name: 'Ada' });
    t.pulse.turnEnded('user');
    t.advance(IDLE_BEFORE_PULSE_MS);
    expect(t.pulse.tick()).toBe('pulse');
    expect(t.sent[0][1]).toMatch(/Ada is building/);
    t.pulse.turnEnded('pulse');
    t.advance(BACKOFF_MS[2] * 2);
    expect(t.pulse.tick()).toBeNull();
    // A second builder joins: that's new.
    t.working.push({ id: 'kit', name: 'Kit' });
    expect(t.pulse.tick()).toBe('pulse');
    expect(t.sent[1][1]).toMatch(/Ada and Kit are building/);
  });

  it('spaces nudges by the backoff when new things keep coming', () => {
    const t = setup();
    t.advance(IDLE_BEFORE_PULSE_MS);
    t.agenda.push({ id: 'a' });
    expect(t.pulse.tick()).toBe('pulse');
    t.agenda.unshift({ id: 'b' });
    t.advance(BACKOFF_MS[1] - 1);
    expect(t.pulse.tick()).toBeNull();
    t.advance(1);
    expect(t.pulse.tick()).toBe('pulse');
    t.agenda.unshift({ id: 'c' });
    t.advance(BACKOFF_MS[2] - 1);
    expect(t.pulse.tick()).toBeNull();
    t.advance(1);
    expect(t.pulse.tick()).toBe('pulse');
    expect(t.sent.map((s) => s[0])).toEqual(['pulse', 'pulse', 'pulse']);
  });

  it('resets the backoff when the person is active again', () => {
    const t = setup({ agenda: 1 });
    t.advance(IDLE_BEFORE_PULSE_MS);
    t.pulse.tick();
    t.agenda.unshift({ id: 'later' });
    t.advance(BACKOFF_MS[1]);
    t.pulse.tick();
    t.pulse.userActive();
    t.ws.lastUserActivityAt = t.now;
    t.agenda.unshift({ id: 'newest' });
    t.advance(Math.max(IDLE_BEFORE_PULSE_MS, BACKOFF_MS[0]));
    expect(t.pulse.tick()).toBe('pulse');
  });

  it('delivers urgent events quickly, but never over the person or the lead', () => {
    const t = setup();
    t.events.push({ urgent: true });
    t.advance(500);
    expect(t.pulse.tick()).toBeNull(); // the person just spoke
    t.advance(1500);
    t.ws.presence = 'speaking';
    expect(t.pulse.tick()).toBeNull();
    t.ws.presence = 'idle';
    t.lead.busy = true;
    expect(t.pulse.tick()).toBeNull();
    t.lead.busy = false;
    t.lead.speechEndsAt = t.now + 3000;
    expect(t.pulse.tick()).toBeNull();
    t.advance(3000);
    expect(t.pulse.tick()).toBe('events');
    expect(t.sent).toEqual([['events', '']]);
  });

  it('non-urgent events still earn a nudge after the quiet', () => {
    const t = setup();
    t.pulse.turnEnded('user');
    t.events.push({ urgent: false });
    t.advance(IDLE_BEFORE_PULSE_MS);
    expect(t.pulse.pending()).toBe('events');
    expect(t.pulse.tick()).toBe('pulse');
  });

  it('nudges a brand-new empty project once', () => {
    const t = setup({ isNew: true });
    t.advance(IDLE_BEFORE_PULSE_MS);
    expect(t.pulse.pending()).toBe('empty');
    expect(t.pulse.tick()).toBe('pulse');
    t.advance(BACKOFF_MS[2]);
    expect(t.pulse.tick()).toBeNull();
  });
});
