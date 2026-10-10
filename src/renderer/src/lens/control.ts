// Lets other layers (the palette) leave the lens politely: if the open file
// has unsaved edits, the lens asks first and runs `then` only once settled.
import { ui } from '../state/store';

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

// "Show what changed": the crew list opens a file's lens on its diff.
let changesFor: string | null = null;

/** Open the lens on a file's changes since the last commit. */
export function openChanges(path: string): void {
  changesFor = path;
  ui.openFile(path);
}

/** The lens opening `path` takes the request to start on its changes (true once). */
export function takeChangesRequest(path: string): boolean {
  if (changesFor !== path) return false;
  changesFor = null;
  return true;
}

/** Whether the lens about to open `path` should start on its changes (doesn't take the request). */
export function wantsChanges(path: string): boolean {
  return changesFor === path;
}
