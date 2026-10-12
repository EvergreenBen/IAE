// The utterance being composed, typed or spoken: presence, architecture
// autocomplete (ghosts) and sending. One module so voice and keyboard behave
// identically.
//
// Ghost lifecycle: every change → instant lexicon ghosts + a debounced
// bridge.draft() for the sketch model. On send the ghosts stay until the
// lead's reply settles (real nodes replace them by id), then the leftovers
// dissolve ~1.5s later. On clear they dissolve almost at once.

import type { Presence } from '@shared/bridge';
import type { GhostProposal } from '@shared/model';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import { voice } from '../voice/controller';
import { turnTrace } from '../voice/trace';
import { activeQuestion, answersQuestion } from './context';
import { lexiconProposals, sameProposals } from './lexicon';

const DRAFT_DEBOUNCE_MS = 350;
const CLEAR_ON_ABANDON_MS = 450;
const CLEAR_AFTER_REPLY_MS = 1500;
const CLEAR_FALLBACK_MS = 25_000;
const TYPING_IDLE_MS = 4000;
/** What they said stays in the intent line until the answer begins, or this long at most. */
const HEARD_MAX_MS = 20_000;

// ── presence ────────────────────────────────────────────────────────────────

const presence = { typing: false, speaking: false };
let sentPresence: Presence = 'idle';
let typingTimer: ReturnType<typeof setTimeout> | undefined;

function syncPresence(): void {
  const p: Presence = presence.speaking ? 'speaking' : presence.typing ? 'typing' : 'idle';
  if (p === sentPresence) return;
  sentPresence = p;
  void bridge.setPresence(p);
}

/** The user is speaking (voice capture) or not. */
export function setSpeaking(on: boolean): void {
  presence.speaking = on;
  syncPresence();
}

/** A keystroke in the intent line. Typing lapses after a few quiet seconds. */
export function noteTyping(hasText: boolean): void {
  clearTimeout(typingTimer);
  presence.typing = hasText;
  if (hasText) typingTimer = setTimeout(() => ((presence.typing = false), syncPresence()), TYPING_IDLE_MS);
  syncPresence();
}

// ── drafts & ghosts ─────────────────────────────────────────────────────────

let draftId: string | null = null;
let draftSeq = 0;
let lastDrafted = '';
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let lexicon: GhostProposal[] = [];
const finished = new Set<string>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let stopWaiting: (() => void) | null = null;
let clearPending = false;

/** The current text of the utterance changed (typed or interim speech). */
export function draft(text: string, via: 'text' | 'voice' = 'voice'): void {
  const t = text.trim();
  if (!t) return abandon();
  if (useIae.getState().voice.heard) ui.voice({ heard: undefined });
  cancelClear();
  draftId ??= `draft-${Date.now().toString(36)}-${++draftSeq}`;
  // Typed text may end mid-word: its last word only counts once finished (lexicon.ts).
  const proposals = lexiconProposals(text, useIae.getState().map, { typing: via === 'text' });
  if (!sameProposals(proposals, lexicon)) {
    lexicon = proposals;
    ui.setLexiconGhosts(proposals);
  }
  clearTimeout(draftTimer);
  const id = draftId;
  draftTimer = setTimeout(() => {
    if (draftId === id && t !== lastDrafted) {
      lastDrafted = t;
      void bridge.draft(id, t);
    }
  }, DRAFT_DEBOUNCE_MS);
}

/** The utterance was cleared without sending: ghosts dissolve. */
export function abandon(): void {
  if (!draftId && !lexicon.length) return;
  finish();
  scheduleClear(CLEAR_ON_ABANDON_MS);
}

/** Send a finished utterance. Slash commands go to Claude Code. */
export function send(raw: string, via: 'text' | 'voice'): void {
  const text = raw.trim();
  if (!text) return;
  finish();
  noteTyping(false);
  // A new turn makes whatever the lead is still saying stale (voice already barged in when they started talking).
  if (via === 'text') voice.bargeIn();
  if (via === 'text' && /^\/[\w:-]/.test(text)) {
    void bridge.runCommand(text);
    scheduleClear(CLEAR_ON_ABANDON_MS);
    return;
  }
  const s = useIae.getState();
  const question = activeQuestion(s.agenda, (s as { activeAgendaId?: string | null }).activeAgendaId);
  const aboutOtherNode = s.selectedNodeId && question && question.nodeId !== s.selectedNodeId;
  const agendaId = question && !aboutOtherNode && answersQuestion(text, question) ? question.id : undefined;
  if (via === 'voice') turnTrace.mark('sent');
  void bridge.say(text, agendaId ? { via, agendaId } : { via });
  showHeard(text);
  clearAfterReply();
}

let heardTimer: ReturnType<typeof setTimeout> | undefined;

/** Their words stay, settled, in the intent line until the answer begins (useVoice clears them then). */
function showHeard(text: string): void {
  clearTimeout(heardTimer);
  ui.voice({ heard: text });
  heardTimer = setTimeout(() => {
    if (useIae.getState().voice.heard === text) ui.voice({ heard: undefined });
  }, HEARD_MAX_MS);
}

function finish(): void {
  clearTimeout(draftTimer);
  if (draftId) finished.add(draftId);
  if (finished.size > 50) finished.delete(finished.values().next().value!);
  draftId = null;
  lastDrafted = '';
  lexicon = [];
}

function cancelClear(): void {
  clearTimeout(clearTimer);
  clearTimeout(fallbackTimer);
  stopWaiting?.();
  stopWaiting = null;
  clearPending = false;
}

function scheduleClear(ms: number): void {
  cancelClear();
  clearPending = true;
  clearTimer = setTimeout(() => {
    clearPending = false;
    if (!draftId) ui.clearGhosts();
  }, ms);
}

/**
 * Keep the ghosts while the lead answers; dissolve the leftovers once it has
 * acted. The lead speaks first, then changes the map: the first map change
 * after sending (real nodes taking over their ghosts) or the end of the reply,
 * whichever comes first, starts the short fade.
 */
function clearAfterReply(): void {
  cancelClear();
  clearPending = true;
  const start = useIae.getState();
  let busy = start.lead.state !== 'idle';
  const unsub = useIae.subscribe((s) => {
    if (s.lead.state !== 'idle') busy = true;
    if (s.map !== start.map || s.lead.lastAt !== start.lead.lastAt || (busy && s.lead.state === 'idle')) scheduleClear(CLEAR_AFTER_REPLY_MS);
  });
  stopWaiting = unsub;
  fallbackTimer = setTimeout(() => scheduleClear(0), CLEAR_FALLBACK_MS);
}

// A sketch result for an utterance that is already over and whose ghosts were
// already cleared would otherwise linger: dissolve it.
useIae.subscribe((s, prev) => {
  if (s.ghosts === prev.ghosts || !s.ghostDraftId || draftId || clearPending) return;
  if (finished.has(s.ghostDraftId)) scheduleClear(CLEAR_ON_ABANDON_MS);
});
