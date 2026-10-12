// The technical detail a node reveals on hover or selection: the name a
// developer would use and its stack. Labels stay plain English; this is the
// detail on demand. Null when there's nothing technical to add.
import type { ArchNode } from '@shared/model';

export interface TechLine {
  /** techLabel, unless it only repeats the label. */
  name: string | null;
  stack: string[];
}

/** About how many 10px mono characters fit the caption's width (CAPTION.w). */
export const TECH_FIT = 34;
const SEP = ' · '.length;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function techLine(node: Pick<ArchNode, 'label' | 'techLabel' | 'tech' | 'summary'>, fit = TECH_FIT): TechLine | null {
  const tl = node.techLabel?.trim();
  const name = tl && !same(tl, node.label) ? tl : null;
  // Without a summary the caption already shows the stack (fallbackLine), so don't repeat it.
  const candidates = node.summary ? (node.tech ?? []).map((t) => t.trim()).filter((t) => t && !(name && same(t, name))) : [];
  // Whole items only: a stack cut mid-word reads worse than a shorter one.
  const stack: string[] = [];
  let len = name?.length ?? 0;
  for (const t of candidates.slice(0, 3)) {
    const next = len + (len ? SEP : 0) + t.length;
    if (next > fit) break;
    stack.push(t);
    len = next;
  }
  return name || stack.length ? { name, stack } : null;
}
