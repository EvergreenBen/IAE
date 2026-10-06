// What the lead says out loud. Replies stream as text deltas; tags such as
// <silence/> (and any stray XML) must never reach the caption or the voice,
// even when a tag arrives split across deltas.

const TAG = /<\/?[A-Za-z][^<>]{0,80}>/g;
const MAX_TAG = 90;

/** Could `tail` (starting with "<") still become a tag as more text streams in? */
function mayBeTag(tail: string): boolean {
  if (tail.length > MAX_TAG) return false;
  return /^<\/?([A-Za-z][^<>]*)?$/.test(tail);
}

export class SpeechFilter {
  silent = false;
  private held = '';
  private started = false;

  /** Feeds a delta; returns the text that is safe to show and speak now. */
  push(chunk: string): string {
    let s = this.held + chunk;
    this.held = '';
    let out = '';
    while (s) {
      const lt = s.indexOf('<');
      if (lt === -1) {
        out += s;
        break;
      }
      out += s.slice(0, lt);
      const rest = s.slice(lt);
      const m = /^<\/?([A-Za-z][^<>]{0,80})>/.exec(rest);
      if (m) {
        if (/^silence\b/i.test(m[1])) this.silent = true;
        s = rest.slice(m[0].length);
        continue;
      }
      if (mayBeTag(rest)) {
        this.held = rest;
        break;
      }
      // Not a tag ("x < 3"): emit the "<" literally and keep scanning.
      out += '<';
      s = rest.slice(1);
    }
    if (!this.started) {
      out = out.replace(/^\s+/, '');
      if (out) this.started = true;
    }
    return out;
  }

  /** End of the reply: whatever is held is either an unfinished tag (dropped) or text. */
  end(): string {
    const held = this.held;
    this.held = '';
    if (!held || mayBeTag(held)) return '';
    return this.started ? held : held.replace(/^\s+/, '');
  }
}

/** The final, speakable reply. Empty when the lead chose silence. */
export function cleanReply(raw: string): string {
  if (/<silence\s*\/?>/i.test(raw)) return '';
  return raw.replace(TAG, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}
