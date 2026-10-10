// What the lead says out loud. Replies stream as text deltas; tags such as
// <silence/> (and any stray XML) must never reach the caption or the voice,
// even when a tag arrives split across deltas. Nor does markdown: after a look
// at the code the model sometimes writes a numbered list with bold and
// backticks, which the voice would read out as symbols.

const TAG = /<\/?[A-Za-z][^<>]{0,80}>/g;
const MAX_TAG = 90;
/** A line break, and the list mark or heading it opens ("\n2. ", "\n- ", "\n## "): spoken as a space. */
const LINE_MARK = /[ \t]*\n\s*(?:(?:[-•]|\d{1,2}[.)]|#{1,6})[ \t]+)?/g;
/** The end of a delta that may still become a LINE_MARK as more text streams in. */
const MAY_BE_MARK = /[ \t]*\n\s*(?:[-•]|\d{1,2}[.)]?|#{1,6})?$/;
/** Emphasis and code marks: never spoken. */
const MARKS = /[*`]/g;

/** Speakable text: line breaks, list marks, headings, bold and backticks become plain words. */
export function unmark(text: string): string {
  return text.replace(LINE_MARK, ' ').replace(MARKS, '');
}

/** Could `tail` (starting with "<") still become a tag as more text streams in? */
function mayBeTag(tail: string): boolean {
  if (tail.length > MAX_TAG) return false;
  return /^<\/?([A-Za-z][^<>]*)?$/.test(tail);
}

export class SpeechFilter {
  silent = false;
  private held = '';
  /** Text held back because it may be the start of a list mark ("\n1"). */
  private tail = '';
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
        // Silence chosen up front is a silent reply; after words, it only ends them (they were heard).
        if (/^silence\b/i.test(m[1]) && !this.started && !out.trim()) this.silent = true;
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
    out = this.tail + out;
    this.tail = '';
    const mark = MAY_BE_MARK.exec(out);
    if (mark) {
      this.tail = out.slice(mark.index);
      out = out.slice(0, mark.index);
    }
    out = unmark(out);
    if (!this.started) {
      out = out.replace(/^\s+/, '');
      if (out) this.started = true;
    }
    return out;
  }

  /**
   * The text block ended (tools are starting): release what was held back as a
   * possible list mark (a trailing "\n" becomes a space), so the sentence before
   * the tools reads as finished. A held partial tag stays held.
   */
  flushTail(): string {
    const out = unmark(this.tail);
    this.tail = '';
    return this.started ? out : out.replace(/^\s+/, '');
  }

  /** End of the reply: whatever is held is either an unfinished tag (dropped) or text. */
  end(): string {
    const held = this.held;
    this.held = '';
    const rest = unmark(this.tail + (held && !mayBeTag(held) ? held : ''));
    this.tail = '';
    return this.started ? rest.replace(/\s+$/, '') : rest.trim();
  }
}

/**
 * The final, speakable reply. Empty when the lead chose silence; words before
 * a <silence/> were already spoken, so they stay.
 */
export function cleanReply(raw: string): string {
  return unmark(raw.replace(TAG, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
}
