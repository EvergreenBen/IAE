// Lets other layers (the palette) leave the lens politely: if the open file
// has unsaved edits, the lens asks first and runs `then` only once settled.
type Closer = (then?: () => void) => void;

let closer: Closer | null = null;

/** Called by the lens while it's open. Returns an unregister function. */
export function registerLensCloser(fn: Closer): () => void {
  closer = fn;
  return () => {
    if (closer === fn) closer = null;
  };
}

/** Close the lens if it's open (asking about unsaved edits), then run `then`. */
export function closeLensThen(then: () => void): void {
  if (closer) closer(then);
  else then();
}
