// Which open question gets the one card. Pure, so it can be tested.
//
// Priority decides, with two exceptions that keep the card and the caption
// telling the same story:
//  - a freshly raised item (the one Archie most likely just mentioned) takes
//    the slot from older items, unless an older one is holding up a builder;
//  - the card already up stays up (no swapping under the user's eyes) until a
//    fresher or more urgent item arrives, or it is answered.
import type { AgendaItem } from '@shared/model';

/** How long an item counts as just raised. */
export const FRESH_MS = 20_000;

export interface PickOptions {
  now: number;
  /** Deferred with "later": they wait behind everything else. */
  later: string[];
  /** The item whose card is up right now, if any. */
  current: string | null;
  /** Is a live builder waiting on this item? */
  blocking: (item: AgendaItem) => boolean;
}

/** Open items in the order they deserve the card (best first). */
export function orderAgenda<T extends { item: AgendaItem }>(list: T[], o: PickOptions): T[] {
  const fresh = (i: AgendaItem) => o.now - i.createdAt < FRESH_MS && o.now >= i.createdAt - 1000;
  const key = (x: T) => {
    const i = x.item;
    const deferred = o.later.includes(i.id);
    const f = !deferred && fresh(i);
    // Tiers: holding up a builder (2) + just raised or already up (1).
    const tier = deferred ? -10 : (o.blocking(i) ? 2 : 0) + (f || i.id === o.current ? 1 : 0);
    return { tier, fresh: f ? i.createdAt : -Infinity, current: i.id === o.current ? 1 : 0, priority: i.priority, createdAt: i.createdAt };
  };
  return list
    .map((x) => ({ x, k: key(x) }))
    .sort(
      (a, b) =>
        b.k.tier - a.k.tier ||
        // Within a tier the newest fresh item leads (it's what was just said), then the card already up.
        (b.k.fresh === a.k.fresh ? 0 : b.k.fresh > a.k.fresh ? 1 : -1) ||
        b.k.current - a.k.current ||
        b.k.priority - a.k.priority ||
        a.k.createdAt - b.k.createdAt,
    )
    .map((e) => e.x);
}
