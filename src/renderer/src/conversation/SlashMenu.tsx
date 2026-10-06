// "/" at the start of the intent line: Claude Code's commands and skills,
// fuzzy-filtered, above the line. ↑↓ to move, ↵ to run, Tab to complete.

import type { SlashCommandInfo } from '@shared/model';
import styles from './SlashMenu.module.css';

/** Subsequence match with a bonus for prefixes and word starts. -1 = no match. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 1000 - t.length;
  let score = 0;
  let ti = 0;
  let prev = -2;
  const isStart = (i: number) => i === 0 || /[-_:\s/]/.test(t[i - 1]);
  for (const ch of q) {
    // Keep a run going if we can; otherwise prefer a word start ("sr" → security-review).
    let i = -1;
    if (!(prev >= 0 && t[prev + 1] === ch)) {
      for (let k = ti; k < t.length && i === -1; k++) if (t[k] === ch && isStart(k)) i = k;
    }
    if (i === -1) i = t.indexOf(ch, ti);
    if (i === -1) return -1;
    score += i === prev + 1 ? 8 : 1;
    if (isStart(i)) score += 6;
    prev = i;
    ti = i + 1;
  }
  return score - t.length * 0.1;
}

export function filterCommands(all: SlashCommandInfo[], query: string, limit = 7): SlashCommandInfo[] {
  return all
    .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.name), fuzzyScore(query, c.description) * 0.3) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

interface Props {
  items: SlashCommandInfo[];
  active: number;
  loading: boolean;
  onPick(cmd: SlashCommandInfo): void;
  onHover(i: number): void;
}

export function SlashMenu({ items, active, loading, onPick, onHover }: Props) {
  return (
    <div className={styles.menu} role="listbox" aria-label="Claude Code commands">
      {items.length === 0 ? (
        <div className={styles.empty}>{loading ? 'Looking for commands…' : 'No matching command'}</div>
      ) : (
        items.map((c, i) => (
          <div
            key={c.name}
            role="option"
            aria-selected={i === active}
            className={styles.item}
            data-active={i === active || undefined}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the input
              onPick(c);
            }}
          >
            <span className={styles.name}>/{c.name}</span>
            {c.argumentHint && <span className={styles.hint}>{c.argumentHint}</span>}
            <span className={styles.desc}>{c.description}</span>
          </div>
        ))
      )}
    </div>
  );
}
