// What the intent line should say and which question an utterance answers.
// Pure helpers over store-shaped data so they can be tested without React.

import type { AgendaItem, ArchMap, ProjectInfo } from '@shared/model';

/** A new project with nothing on the map yet. */
export const isBlankProject = (project: ProjectInfo | null, map: ArchMap): boolean => !!project?.isNew && Object.keys(map.nodes).length === 0;

/** The highest-priority open agenda item (what the map shows as the question card). */
export function topOpenAgenda(agenda: AgendaItem[]): AgendaItem | null {
  let best: AgendaItem | null = null;
  for (const a of agenda) {
    if (a.status !== 'open') continue;
    if (!best || a.priority > best.priority || (a.priority === best.priority && a.createdAt < best.createdAt)) best = a;
  }
  return best;
}

/**
 * The question card currently up. The map may publish `activeAgendaId` (the
 * card it actually shows, null when the user put it away); without it we fall
 * back to the top open item, which is what the map shows by default.
 */
export function activeQuestion(agenda: AgendaItem[], activeAgendaId: string | null | undefined): AgendaItem | null {
  if (activeAgendaId === null) return null;
  if (activeAgendaId) return agenda.find((a) => a.id === activeAgendaId && a.status === 'open') ?? null;
  return topOpenAgenda(agenda);
}

export interface PlaceholderInput {
  blank: boolean;
  selectedLabel: string | null;
  questionUp: boolean;
}

export function placeholderFor({ blank, selectedLabel, questionUp }: PlaceholderInput): string {
  if (selectedLabel) return `About ${selectedLabel}…`;
  if (questionUp) return 'Answer, or say something else…';
  if (blank) return "Describe what you're building…";
  return 'Ask, decide, or describe a change…';
}

/**
 * Short replies that only make sense as an answer: yes/no, an ordinal, "go
 * with …". Openers like "let's", "use" or "keep" start new requests just as
 * often ("Let's plan the offline outbox next"), so they don't count alone.
 */
const ANSWERISH =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|no|nope|nah|the (?:first|second|third|last|former|latter)(?: one)?|first|second|third|either|both|neither|sounds (?:good|right)|do it|agreed|go with|later|not now|skip)\b/i;
/** An answer-like opener only counts when the whole reply is this short. */
const SHORT_REPLY = 5;

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Words too common to count as echoing an option. */
const COMMON = new Set(['with', 'from', 'that', 'this', 'them', 'they', 'then', 'than', 'into', 'have', 'will', 'just', 'only', 'more', 'some', 'also', 'what', 'when', 'your', 'each', 'make', 'want', 'need']);

/**
 * Does this utterance plausibly answer the question? Short answer-like replies
 * ("yes", "the first one", "go with tokens") count, and replies that echo an
 * option: two of its words, or one in a short reply ("tokens are fine").
 * Anything else ("show me the backend") is sent without the agenda id; the
 * lead still sees the open question and can resolve it if it was an answer.
 */
export function answersQuestion(text: string, item: AgendaItem | null): boolean {
  if (!item) return false;
  const t = text.trim();
  if (!t) return false;
  const w = new Set(words(t));
  if (ANSWERISH.test(t) && words(t).length <= SHORT_REPLY) return true;
  for (const opt of item.options ?? []) {
    const hits = new Set(words(opt).filter((x) => x.length > 3 && !COMMON.has(x) && w.has(x))).size;
    if (hits >= 2 || (hits === 1 && w.size <= 8)) return true;
  }
  return false;
}
