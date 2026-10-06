// Pure helpers for the caption: where sentences start (so a long reply can show
// its latest whole sentences instead of a clipped line), the reply's words with
// stable offsets (so dropping an early sentence never re-animates the rest),
// and how long a finished reply stays on screen.

/** Character offsets where each sentence begins. Always starts with 0. */
export function sentenceStarts(text: string): number[] {
  const out = [0];
  const re = /[.!?…]["'”’)\]]*\s+(?=\S)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m.index + m[0].length);
  return out;
}

/** Offsets where words begin at or after `from` (for trimming one long sentence). */
export function wordStarts(text: string, from = 0): number[] {
  const out: number[] = [];
  const re = /\S+/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m.index);
  return out;
}

export interface Token {
  text: string;
  /** Offset in the full reply; doubles as a stable key. */
  at: number;
  space: boolean;
}

export function tokens(text: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  for (const t of text.split(/(\s+)/)) {
    if (t) out.push({ text: t, at, space: /^\s+$/.test(t) });
    at += t.length;
  }
  return out;
}

/** Long enough to read calmly: about 4 words a second, between 6 and 12 seconds. */
export function lingerMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(6000, Math.min(12_000, words * 260));
}
