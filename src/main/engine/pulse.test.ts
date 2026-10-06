import { describe, expect, it } from 'vitest';
import { emptyMap } from '../../shared/map';
import type { TurnKind } from './context';
import { BACKOFF_MS, IDLE_BEFORE_PULSE_MS, Pulse } from './pulse';
import type { Workspace } from './workspace';

function setup(opts: { agenda?: number; isNew?: boolean } = {}) {
  let now = 1_000_000;
  const events: { urgent: boolean }[] = [];
  const ws = {
    isClosed: false,
    presence: 'idle',
    lastUserActivityAt: now,
    info: { isNew: opts.isNew ?? false },
    map: emptyMap(),
    agenda: { open: () => Array.from({ length: opts.agenda ?? 0 }) },
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
  const pulse = new Pulse({ ws: ws as unknown as Workspace, lead, now: () => now });
  return {
    pulse,
    ws,
    lead,
    sent,
    events,
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

  it('nudges after ~20s of quiet when the agenda is open, then backs off', () => {
    const t = setup({ agenda: 1 });
    t.advance(IDLE_BEFORE_PULSE_MS - 1000);
    expect(t.pulse.tick()).toBeNull();
    t.advance(1000);
    expect(t.pulse.tick()).toBe('pulse');
    t.advance(BACKOFF_MS[1] - 1);
    expect(t.pulse.tick()).toBeNull();
    t.advance(1);
    expect(t.pulse.tick()).toBe('pulse');
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
    t.advance(BACKOFF_MS[1]);
    t.pulse.tick();
    t.pulse.userActive();
    t.ws.lastUserActivityAt = t.now;
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

  it('nudges a brand-new empty project', () => {
    const t = setup({ isNew: true });
    t.advance(IDLE_BEFORE_PULSE_MS);
    expect(t.pulse.pending()).toBe('empty');
    expect(t.pulse.tick()).toBe('pulse');
  });
});
