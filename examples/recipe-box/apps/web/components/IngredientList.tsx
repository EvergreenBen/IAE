import type { Ingredient } from "@/lib/api";

function formatQty(q: number | null): string {
  if (q === null) return "";
  const whole = Math.floor(q);
  const frac = Math.round((q - whole) * 8) / 8;
  const glyph: Record<number, string> = { 0.125: "1/8", 0.25: "1/4", 0.5: "1/2", 0.75: "3/4" };
  const f = glyph[frac] ?? "";
  return [whole || "", f].filter(Boolean).join(" ") || String(q);
}

export function IngredientList({ items }: { items: Ingredient[] }) {
  return (
    <ul className="ingredients">
      {items.map((i) => (
        <li key={i.id}>
          <strong>{formatQty(i.quantity)}</strong> {i.unit} {i.name}
        </li>
      ))}
    </ul>
  );
}
