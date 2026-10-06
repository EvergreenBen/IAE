export type ParsedIngredient = { quantity: number | null; unit: string | null; name: string };

const UNITS = new Set([
  "cup", "cups", "tbsp", "tsp", "oz", "lb", "lbs", "g", "kg", "ml", "l", "clove", "cloves", "pinch",
]);

/** Parses "1/2", "2", "2.5" or "2 1/2" style quantities from the front of the token list. */
function parseQuantity(tokens: string[]): number | null {
  let total = 0;
  let used = 0;
  for (const t of tokens.slice(0, 2)) {
    const frac = t.match(/^(\d+)\/(\d+)$/);
    if (frac) total += Number(frac[1]) / Number(frac[2]);
    else if (/^\d+(\.\d+)?$/.test(t)) total += Number(t);
    else break;
    used++;
  }
  tokens.splice(0, used);
  return used ? total : null;
}

export function parseIngredient(line: string): ParsedIngredient {
  const tokens = line.trim().split(/\s+/);
  const quantity = parseQuantity(tokens);
  const unit = tokens[0] && UNITS.has(tokens[0].toLowerCase()) ? tokens.shift()!.toLowerCase() : null;
  return { quantity, unit, name: tokens.join(" ") };
}

// parseIngredient("2 1/2 cups flour") -> { quantity: 2.5, unit: "cups", name: "flour" }
