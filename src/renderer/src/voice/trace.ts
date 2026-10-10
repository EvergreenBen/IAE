// One spoken exchange, timed from the moment the person stops talking to the
// moment Archie's voice starts. One console line per turn ("[voice:turn] …"):
// the numbers to watch when tuning how quickly Archie answers.

type Mark = 'text' | 'sent' | 'words' | 'voice';

let stoppedAt = 0;
let marks: Partial<Record<Mark, number>> = {};
let reported = true;

export const turnTrace = {
  /** The person stopped talking (end of speech, or Space released). */
  stopped(): void {
    stoppedAt = performance.now();
    marks = {};
    reported = false;
  },
  mark(name: Mark): void {
    if (reported || marks[name] !== undefined) return;
    marks[name] = performance.now();
    if (name === 'voice') this.report();
  },
  /** Nothing will be spoken for this turn (silence, or the transcript was empty). */
  drop(): void {
    reported = true;
  },
  report(): void {
    if (reported) return;
    reported = true;
    const at = (m: Mark) => (marks[m] !== undefined ? `${Math.round(marks[m]! - stoppedAt)}` : '–');
    console.info(`[voice:turn] stop→text ${at('text')} · sent ${at('sent')} · first words ${at('words')} · voice ${at('voice')} ms`);
  },
};
