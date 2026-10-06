// A light backstop for one habit the prompt alone doesn't always break: the
// lead tacking an open card's question onto the end of later replies ("…Still
// need your call: membership number or a separate account?"). The card is on
// screen; saying it again is noise. Only near-verbatim repeats (≥ 80% of the
// words) of a question already raised in an earlier turn are trimmed. In a
// reply to the person the opening sentence streams live and isn't checked; a
// nudge (pulse) may bring a card back once while builders work, not again. A
// question that blocks a builder, or a person asking what's left, lets it through.

const STOP = new Set(
  `a an the to of for in on at by with and or but if so then than as is are was were be been being do does did done
  it its it's this that these those there here we you they i i'd i'll i'm me my mine your yours their them our us he she
  should would could can will shall may might must need needs want wants go going keep use just still now also too
  have has had get got make made one first which what how when where who whom whose why
  sound sounds right ok okay yes no sure call your quick question decide choose either`.split(/\s+/),
);

/** Content words, lowercased, crude plural folding. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const t = w.replace(/^'+|'+$/g, '');
    if (!t || STOP.has(t)) continue;
    out.add(t.length > 3 ? t.replace(/(?<!s)s$/, '') : t);
  }
  return out;
}

/** Dice overlap of content words, 0..1. */
export function similarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return (2 * shared) / (x.size + y.size);
}

export const REPEAT_AT = 0.8;
/** An earlier spoken question counts as being about a card at this overlap. */
const ABOUT_AT = 0.3;

export interface OpenCard {
  id: string;
  prompt: string;
  createdAt: number;
}

export interface SpokenQuestion {
  text: string;
  /** When the turn that said it ended. */
  at: number;
  /** Cards that turn put on the map (its questions are how it asked them). */
  cards?: string[];
}

/** The person is asking what's still open: repeating the question is the answer then. */
export function asksWhatsOpen(said: string): boolean {
  return /\b(what'?s next|what now|next step|what('?s| is) (left|open)|left to (decide|answer)|open questions?|remind me|what was (the|that|your) question|(repeat|say) (that|it|the question)( again)?|which question|what do you need from me|what did you ask)\b/i.test(
    said,
  );
}

/** In how many earlier turns the lead asked a card's question out loud. */
export function timesAsked(card: OpenCard, spoken: SpokenQuestion[]): number {
  return new Set(spokenFor(card, spoken).map((p) => p.at)).size;
}

/** How the lead put a card's question out loud in earlier turns (the turn that added it, or later). */
export function spokenFor(card: OpenCard, spoken: SpokenQuestion[]): SpokenQuestion[] {
  return spoken.filter((p) => p.cards?.includes(card.id) || (p.at >= card.createdAt && similarity(p.text, card.prompt) >= ABOUT_AT));
}

/**
 * True when `sentence` asks again what an open card already asks, and the lead
 * already asked it out loud in an earlier turn: near-verbatim to the card, or
 * to how the lead put it then. (A builder's card the lead hasn't raised yet
 * gets said once.)
 */
export function repeatsCard(sentence: string, cards: OpenCard[], spoken: SpokenQuestion[]): boolean {
  if (!sentence.trim().endsWith('?')) return false;
  return cards.some((c) => {
    const said = spokenFor(c, spoken);
    return said.length > 0 && (similarity(sentence, c.prompt) >= REPEAT_AT || said.some((p) => similarity(sentence, p.text) >= REPEAT_AT));
  });
}

/** Question sentences in a reply ("Tokens or cookies?"). */
export function questionSentences(text: string): string[] {
  return splitSentences(text)
    .map((s) => s.trim())
    .filter((s) => s.endsWith('?'));
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?]["')\]]*)\s+/).filter((s) => s.trim());
}

/** The default that usually rides along with a question ("I'd go tokens.", "Sound right?"). */
const DEFAULT_TAIL = /^(I'd|I would|I'll|I lean|I suggest|I recommend|My pick|Default|Otherwise I'll|Sound (right|good)|OK|Okay)\b/i;
const END = /[.!?]["')\]]*\s+/g;

/**
 * Sits between the speech filter and the caption/voice for one turn. The
 * opening sentence of a reply to the person passes straight through; later
 * sentences are released as each completes, minus repeats of an open card
 * (and the default riding on one).
 */
export class RepeatGuard {
  readonly dropped: string[] = [];
  private opened: boolean;
  /** The opening so far (passed through as it streamed). */
  private head = '';
  private buf = '';
  private dropping = false;

  /** `holdOpening`: check the first sentence too (unprompted turns: nobody is waiting for the first word). */
  constructor(
    private readonly isRepeat: (sentence: string) => boolean,
    holdOpening = false,
  ) {
    this.opened = holdOpening;
  }

  push(chunk: string): string {
    if (!chunk) return '';
    if (!this.opened) {
      // The sentence end may straddle chunks ("…sketched." + " Next…").
      const s = this.head + chunk;
      END.lastIndex = Math.max(0, this.head.length - 4);
      const m = END.exec(s);
      if (!m) {
        this.head = s;
        return chunk;
      }
      this.opened = true;
      const cut = Math.max(0, m.index + m[0].length - this.head.length);
      this.head = '';
      return chunk.slice(0, cut) + this.push(chunk.slice(cut));
    }
    this.buf += chunk;
    let out = '';
    for (;;) {
      END.lastIndex = 0;
      const m = END.exec(this.buf);
      if (!m) break;
      const cut = m.index + m[0].length;
      out += this.release(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
    return out;
  }

  /** The text block ended (tools are starting, or the reply is over): settle what's held. */
  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return rest.trim() ? this.release(rest) : rest;
  }

  private release(sentence: string): string {
    if (this.dropping && DEFAULT_TAIL.test(sentence.trim())) {
      this.dropped.push(sentence);
      return '';
    }
    this.dropping = false;
    if (this.isRepeat(sentence.trim())) {
      this.dropped.push(sentence);
      this.dropping = true;
      return '';
    }
    return sentence;
  }
}

/** The final reply text without the sentences the guard dropped. */
export function withoutDropped(text: string, dropped: string[]): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  let out = norm(text);
  for (const d of dropped) {
    const n = norm(d);
    if (n) out = out.replace(n, ' ');
  }
  return norm(out);
}

/** Questions the lead asked out loud, remembered to spot it asking them again. */
const REMEMBER = 30;

interface CardLike extends OpenCard {
  blocking?: string[];
}

/** What the lead has asked out loud across turns, and the guard each new turn gets from it. */
export class AskedQuestions {
  private spoken: SpokenQuestion[] = [];

  /** The lead asked this card's question out loud in an earlier turn. */
  askedAloud(card: OpenCard): boolean {
    return timesAsked(card, this.spoken) > 0;
  }

  /**
   * The guard for a turn: cards the lead already asked out loud aren't asked
   * again (a pulse may bring one back once; a person asking what's left gets
   * them; blocking ones may always be raised). Unprompted turns are checked
   * from their first sentence. Null when there's nothing to guard.
   */
  guard(kind: 'user' | 'events' | 'pulse', said: string, open: CardLike[]): RepeatGuard | null {
    if (asksWhatsOpen(said)) return null;
    const spoken = this.spoken;
    const enough = kind === 'pulse' ? 2 : 1;
    const cards = open.filter((c) => !c.blocking?.length && timesAsked(c, spoken) >= enough).map(({ id, prompt, createdAt }) => ({ id, prompt, createdAt }));
    if (!cards.length) return null;
    return new RepeatGuard((sentence) => repeatsCard(sentence, cards, spoken), kind !== 'user');
  }

  /** A turn ended having said `text`; `newCards` are the cards it put on the map. */
  record(text: string, newCards: string[]): void {
    const at = Date.now();
    for (const q of questionSentences(text)) this.spoken.push({ text: q, at, cards: newCards });
    this.spoken.splice(0, Math.max(0, this.spoken.length - REMEMBER));
  }
}
