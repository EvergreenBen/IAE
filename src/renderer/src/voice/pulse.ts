// A tiny emitter for "a word was just spoken". TTS word boundaries (or, with
// speech off, streaming text) pulse it; Archie's mouth listens. Kept out of
// the store because it fires many times a second.

type Listener = (strength: number) => void;
const listeners = new Set<Listener>();

export function speechPulse(strength = 0.7): void {
  for (const l of listeners) l(strength);
}

export function onSpeechPulse(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
