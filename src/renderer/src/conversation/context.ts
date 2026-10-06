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

const ANSWERISH =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|no|nope|nah|keep|go with|let'?s|use|pick|choose|the (?:first|second|third|last|former|latter)|first|second|option|later|not now|skip|either|both|neither|sounds (?:good|right)|do it|agreed|right|correct|definitely|probably|i'?d (?:say|go|keep|pick))\b/i;

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Does this utterance plausibly answer the question? Short replies, replies
 * that echo an option, and replies that start like an answer count. Longer
 * new requests ("add a billing module") are sent without the agenda id; the
 * lead still sees the open question in its context and can resolve it.
 */
export function answersQuestion(text: string, item: AgendaItem | null): boolean {
  if (!item) return false;
  const t = text.trim();
  if (!t) return false;
  const w = words(t);
  if (ANSWERISH.test(t)) return true;
  for (const opt of item.options ?? []) {
    const ow = words(opt).filter((x) => x.length > 3);
    if (ow.length && ow.some((x) => w.includes(x))) return true;
  }
  return w.length <= 6;
}
