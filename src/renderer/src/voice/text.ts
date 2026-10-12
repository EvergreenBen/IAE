// Text helpers for both directions of speech. Pure.
//
//  - SentenceChunker: turns the lead's streaming deltas into speakable chunks,
//    so speech starts after the first sentence instead of the whole reply.
//  - speakable(): strips markdown and tags the voice shouldn't read out.
//  - cleanTranscript(): removes Whisper's habits on silence.

const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|incl)\.$/i;

/**
 * Where a speaker would take a breath in a sentence with no comma: before a
 * joining word or a preposition ("The jobs worker checks a jobs table | in
 * Postgres every two seconds.").
 */
const BREATH = /\s(?=(?:and|but|so|which|that|because|while|when|where|then|with|after|before|until|unless|since|though|in|on|at|from|into|about|through|across|between|using|via|without|every|instead)\s)/g;
/** The opening is never shorter than this (about four words): enough sound to cover making the next chunk. */
const MIN_OPENING = 20;

export class SentenceChunker {
  private buf = '';
  /** Chunks given out since the reply began. */
  private count = 0;

  constructor(
    /** A clause longer than this is spoken at its last comma/semicolon/dash. */
    private readonly longClause = 120,
    /** The same for a reply's first chunk: kept short, so the voice starts sooner. */
    private readonly firstClause = longClause,
    /** And for the second, which is made while the first plays: short enough to be ready when it ends. */
    private readonly secondClause = Math.min(longClause, Math.max(firstClause * 2, 80)),
  ) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) {
        out.push(chunk);
        this.count++;
      }
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }

  reset(): void {
    this.buf = '';
    this.count = 0;
  }

  /**
   * What's waiting, if it already reads as a finished sentence: the stream
   * paused right after a full stop (the lead went off to read code, say), so
   * nothing will follow it to prove the sentence over. The caller speaks it
   * after a short quiet. Null when it might still continue ("e.g.", "2.").
   */
  settled(): string | null {
    const t = this.buf.trim();
    if (!/[.!?…]["')\]”’]*$/.test(t) || /\d\.$/.test(t) || ABBREVIATIONS.test(t)) return null;
    this.buf = '';
    this.count++;
    return t;
  }

  private findCut(): number {
    const end = this.sentenceEnd();
    const limit = this.count === 0 ? this.firstClause : this.count === 1 ? this.secondClause : this.longClause;
    if (end >= 0 && end <= limit) return end;
    if (this.buf.length <= limit) return end;
    // A reply's opening is cut at a natural break within the limit, so the voice starts sooner.
    if (this.count === 0) {
      const cut = this.openingCut(limit);
      if (cut > 0) return cut;
    }
    // A long sentence (finished or still arriving) is spoken a clause at a time.
    const window = this.buf.slice(0, end >= 0 ? Math.min(end, limit + 40) : limit + 40);
    const re = /[,;:—–]\s/g;
    const minAt = Math.min(40, limit / 3);
    let last = -1;
    for (let m = re.exec(window); m; m = re.exec(window)) if (m.index > minAt) last = m.index + 1;
    return last > 0 ? last : end;
  }

  /** The longest natural phrase within `limit`: up to a comma, else up to a breath. -1 when there is none. */
  private openingCut(limit: number): number {
    const head = this.buf.slice(0, limit + 1);
    let cut = -1;
    for (const m of head.matchAll(/[,;:—–](?=\s)/g)) if (m.index + 1 >= MIN_OPENING && m.index + 1 <= limit) cut = m.index + 1;
    if (cut > 0) return cut;
    for (const m of head.matchAll(BREATH)) if (m.index >= MIN_OPENING && m.index <= limit) cut = m.index;
    return cut;
  }

  private sentenceEnd(): number {
    const re = /[.!?…]+["')\]”’]*(?=\s)/g;
    for (let m = re.exec(this.buf); m; m = re.exec(this.buf)) {
      if (m[0].startsWith('.') && ABBREVIATIONS.test(this.buf.slice(0, m.index + 1))) continue;
      return m.index + m[0].length;
    }
    return -1;
  }
}

/** Text as it should be spoken: no markdown, tags, code fences or bare URLs. */
export function speakable(text: string): string {
  return text
    .replace(/<\/?[a-z_]+\/?>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[`*_#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whisper "hears" these in silence or noise.
const ALWAYS_DROP = new Set([
  'you',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'please subscribe',
  'like and subscribe',
  'bye',
  'the end',
]);
const DROP_IF_BARELY_VOICED = new Set(['thank you', 'thanks', 'thank you so much', 'okay', 'oh', 'um', 'uh', 'hmm', 'so']);

/**
 * Clean a raw Whisper transcript. Returns '' when there is nothing real in it.
 * `voicedMs` is how much of the utterance actually carried voice energy.
 */
export function cleanTranscript(raw: string, voicedMs = Number.POSITIVE_INFINITY): string {
  let t = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.,\-–—\s]+/, '');
  // Whisper sometimes loops on a word: "the the the the".
  t = t.replace(/\b(\w+)(?:[\s,]+\1\b){3,}/gi, '$1');
  if (!/[a-z0-9]/i.test(t)) return '';
  const key = t
    .toLowerCase()
    .replace(/[^a-z' ]/g, '')
    .trim();
  if (ALWAYS_DROP.has(key)) return '';
  if (voicedMs < 700 && DROP_IF_BARELY_VOICED.has(key)) return '';
  return t;
}

/** Words a sentence doesn't end on: someone who stops after one of these is still thinking. */
const TRAILING = /(?:^|\s)(?:and|or|but|so|because|the|a|an|to|of|with|for|like|um|uh|er|if|then|that|which|when|my|your|our|their|is|are|was|were|i|we|you|it's|in|on|at|from|about|maybe)$/i;

/**
 * How much silence should end the turn, given what was said up to the pause:
 * shorter after something that sounds finished, longer when they trailed off
 * mid-thought ("…and", "so…", "the"). Pure.
 */
export function turnEndMs(text: string): number {
  const t = text.trim();
  if (!t) return 700;
  const bare = t.replace(/[.!?…,;:—–-]+$/, '').trim();
  if (/(?:\.\.\.|…|[,;:—–-])$/.test(t) || TRAILING.test(bare)) return 1300;
  if (/\?$/.test(t)) return 420;
  if (/[.!]$/.test(t)) return 520;
  return 700;
}
