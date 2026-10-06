// Ghosts on screen over time: once shown, a ghost stays at least a moment (no
// flashes while a word is half typed or the sketcher changes its mind), and
// only the few most likely ideas show at once. Pure, so it can be tested; the
// caller keeps the returned `held` between renders.
import type { GhostProposal } from '@shared/model';
import { sameIdea, tokensOf } from './ghostDedupe';

/** A shown ghost stays at least this long. */
export const MIN_SHOW_MS = 1200;
/** At most this many ghosts at once (the most confident win). */
export const MAX_GHOSTS = 6;

export interface Held {
  g: GhostProposal;
  /** When it first showed. */
  since: number;
}

export interface HoldResult {
  shown: GhostProposal[];
  held: Map<string, Held>;
  /** A newcomer that takes over a dropped ghost's idea, so it can take its spot: new key → old key. */
  inherit: Map<string, string>;
  /** Look again in this many ms (a lingering ghost comes due), or null. */
  wakeIn: number | null;
}

/**
 * `incoming` is what should show now (deduped, in this scope), in order.
 * `real(key)`: the ghost became a node, so it goes at once (it turns into the node).
 */
export function holdGhosts(prev: Map<string, Held>, incoming: GhostProposal[], now: number, real: (key: string) => boolean, max = MAX_GHOSTS, minMs = MIN_SHOW_MS): HoldResult {
  const young = (h: Held) => now - h.since < minMs;
  const inKeys = new Set(incoming.map((g) => g.key));
  const inherit = new Map<string, string>();

  // Shown ghosts that dropped out of the proposals linger while young, unless
  // they became real, or another ghost now carries the same idea (it takes their spot).
  const lingering: Held[] = [];
  for (const [key, h] of prev) {
    if (inKeys.has(key) || real(key) || !young(h)) continue;
    const t = tokensOf(h.g.label);
    const heir = incoming.find((g) => !prev.has(g.key) && sameIdea(tokensOf(g.label), t));
    if (heir) {
      if (!inherit.has(heir.key)) inherit.set(heir.key, key);
      continue;
    }
    lingering.push(h);
  }

  // Young shown ghosts are protected; the rest compete on confidence for what's left.
  const protectedKeys = new Set(lingering.map((h) => h.g.key));
  for (const g of incoming) {
    const h = prev.get(g.key);
    if (h && young(h)) protectedKeys.add(g.key);
  }
  const room = Math.max(0, max - protectedKeys.size);
  const rivals = incoming
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => !protectedKeys.has(g.key))
    // Already showing wins a tie, then the order said.
    .sort((a, b) => b.g.confidence - a.g.confidence || (prev.has(b.g.key) ? 1 : 0) - (prev.has(a.g.key) ? 1 : 0) || a.i - b.i)
    .slice(0, room);
  const pick = new Set([...protectedKeys, ...rivals.map((r) => r.g.key)]);

  const shown = [...incoming.filter((g) => pick.has(g.key)), ...lingering.map((h) => h.g)];
  const held = new Map<string, Held>();
  for (const g of shown) held.set(g.key, { g, since: prev.get(g.key)?.since ?? now });
  // Lingering ghosts come due; with more ideas than room, the ranking changes as protections lapse.
  const capped = incoming.length > max;
  let wakeIn: number | null = null;
  for (const h of held.values()) {
    const due = h.since + minMs - now;
    if (due > 0 && (capped || !inKeys.has(h.g.key))) wakeIn = wakeIn === null ? due : Math.min(wakeIn, due);
  }
  return { shown, held, inherit, wakeIn };
}
