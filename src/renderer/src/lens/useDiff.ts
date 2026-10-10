// The open file's changes since the last commit, for the lens's Changes view.
// Fetched when the file opens and again when `refresh` changes (an agent
// edited it, or the view came up); the last answer stays while a new one loads.
import type { FileDiff } from '@shared/model';
import { useEffect, useState } from 'react';
import { bridge } from '../bridge';

export type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; diff: FileDiff }
  /** The project isn't a git repository: there's no last commit to compare with. */
  | { status: 'nogit' }
  | { status: 'error'; message: string };

const LOADING: DiffState = { status: 'loading' };

export function useDiff(path: string, enabled: boolean, refresh: string): DiffState {
  const [got, setGot] = useState<{ path: string; state: DiffState } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    bridge.diffFile(path).then(
      (diff) => live && setGot({ path, state: diff ? { status: 'ready', diff } : { status: 'nogit' } }),
      (err: unknown) => live && setGot({ path, state: { status: 'error', message: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      live = false;
    };
  }, [path, enabled, refresh]);
  return got && got.path === path ? got.state : LOADING;
}

/** Something changed since the last commit. */
export const hasChanges = (st: DiffState): boolean => st.status === 'ready' && st.diff.status !== 'unchanged';
