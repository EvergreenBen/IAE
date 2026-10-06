// Text helpers for both directions of speech. Pure.
//
//  - SentenceChunker: turns the lead's streaming deltas into speakable chunks,
//    so speech starts after the first sentence instead of the whole reply.
//  - speakable(): strips markdown and tags the voice shouldn't read out.
//  - cleanTranscript(): removes Whisper's habits on silence.

const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|incl)\.$/i;

export class SentenceChunker {
  private buf = '';

  constructor(
    /** A clause longer than this is spoken at its last comma/semicolon/dash. */
    private readonly longClause = 120,
  ) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) out.push(chunk);
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
  }

  private findCut(): number {
    const re = /[.!?…]+["')\]”’]*(?=\s)/g;
    for (let m = re.exec(this.buf); m; m = re.exec(this.buf)) {
      const end = m.index + m[0].length;
      if (m[0].startsWith('.') && ABBREVIATIONS.test(this.buf.slice(0, m.index + 1))) continue;
      return end;
    }
    if (this.buf.length > this.longClause) {
      const window = this.buf.slice(0, this.longClause + 40);
      const re2 = /[,;:—–]\s/g;
      let last = -1;
      for (let m = re2.exec(window); m; m = re2.exec(window)) if (m.index > 40) last = m.index + 1;
      if (last > 0) return last;
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
