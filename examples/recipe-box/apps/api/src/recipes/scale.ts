import type { ParsedIngredient } from "./parse-ingredients";

/** Scale quantities from one serving count to another, rounding to the nearest 1/8. */
export function scaleQuantity(quantity: number, from: number, to: number): number {
  if (from <= 0 || to <= 0) throw new RangeError("servings must be positive");
  return Math.round(((quantity * to) / from) * 8) / 8;
}

export function scaleIngredients<T extends ParsedIngredient>(items: T[], from: number, to: number): T[] {
  if (from === to) return items;
  return items.map((i) => (i.quantity === null ? i : { ...i, quantity: scaleQuantity(i.quantity, from, to) }));
}
