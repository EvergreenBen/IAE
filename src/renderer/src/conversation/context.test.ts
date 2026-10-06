import { describe, expect, it } from 'vitest';
import { applyOps, emptyMap } from '@shared/map';
import type { AgendaItem, ProjectInfo } from '@shared/model';
import { activeQuestion, answersQuestion, isBlankProject, placeholderFor, topOpenAgenda } from './context';

const item = (id: string, priority: number, extra: Partial<AgendaItem> = {}): AgendaItem => ({
  id,
  kind: 'decision',
  prompt: 'Keep cookie sessions or move to short-lived tokens?',
  options: ['Short-lived tokens + refresh', 'Keep cookie sessions', 'Decide later'],
  priority,
  status: 'open',
  createdAt: priority * 10,
  ...extra,
});

const project = (isNew: boolean): ProjectInfo => ({ root: '/p', name: 'P', isNew, lastOpenedAt: 0 });

describe('agenda helpers', () => {
  it('finds the top open item', () => {
    expect(topOpenAgenda([item('a', 0.4), item('b', 0.9), item('c', 1, { status: 'answered' })])?.id).toBe('b');
    expect(topOpenAgenda([])).toBeNull();
  });

  it('honours the map’s active card when it publishes one', () => {
    const agenda = [item('a', 0.4), item('b', 0.9)];
    expect(activeQuestion(agenda, undefined)?.id).toBe('b');
    expect(activeQuestion(agenda, 'a')?.id).toBe('a');
    expect(activeQuestion(agenda, null)).toBeNull();
    expect(activeQuestion(agenda, 'gone')).toBeNull();
  });
});

describe('placeholder', () => {
  const map = applyOps(emptyMap(), [{ op: 'upsertNode', node: { id: 'api', label: 'API', kind: 'service' } }]);
  it('knows a blank project', () => {
    expect(isBlankProject(project(true), emptyMap())).toBe(true);
    expect(isBlankProject(project(true), map)).toBe(false);
    expect(isBlankProject(project(false), emptyMap())).toBe(false);
  });
  it('follows context', () => {
    expect(placeholderFor({ blank: true, selectedLabel: null, questionUp: false })).toBe("Describe what you're building…");
    expect(placeholderFor({ blank: false, selectedLabel: null, questionUp: false })).toBe('Ask, decide, or describe a change…');
    expect(placeholderFor({ blank: false, selectedLabel: 'Auth', questionUp: true })).toBe('About Auth…');
    expect(placeholderFor({ blank: false, selectedLabel: null, questionUp: true })).toBe('Answer, or say something else…');
  });
});

describe('answersQuestion', () => {
  const q = item('q', 0.9);
  it('ties answers to the question', () => {
    expect(answersQuestion('tokens', q)).toBe(true);
    expect(answersQuestion('Keep the cookie sessions for now, mobile is far off and I do not want to rework login', q)).toBe(true);
    expect(answersQuestion("let's do short-lived tokens with refresh", q)).toBe(true);
    expect(answersQuestion('yes', q)).toBe(true);
  });
  it('leaves new requests untied', () => {
    expect(answersQuestion('add a billing module with stripe checkout and a webhook handler', q)).toBe(false);
    expect(answersQuestion('anything', null)).toBe(false);
    expect(answersQuestion('  ', q)).toBe(false);
  });
});
