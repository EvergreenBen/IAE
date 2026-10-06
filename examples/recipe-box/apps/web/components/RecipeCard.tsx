import Link from "next/link";
import type { Recipe } from "@/lib/api";

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <Link href={`/recipe/${recipe.id}`} className="card">
      {recipe.thumbnailUrl ? (
        <img src={recipe.thumbnailUrl} alt="" width={320} height={200} />
      ) : (
        <div className="placeholder" />
      )}
      <h3>{recipe.title}</h3>
      <p>
        Serves {recipe.servings} · {recipe.ingredients.length} ingredients
      </p>
    </Link>
  );
}
