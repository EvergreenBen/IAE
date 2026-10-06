import Link from "next/link";
import { getRecipe } from "@/lib/api";
import { IngredientList } from "@/components/IngredientList";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ servings?: string }> };

export default async function RecipePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { servings } = await searchParams;
  const recipe = await getRecipe(id, servings ? Number(servings) : undefined);
  return (
    <article>
      <h1>{recipe.title}</h1>
      <p>Serves {recipe.servings}</p>
      <IngredientList items={recipe.ingredients} />
      <ol>
        {recipe.steps.map((s) => (
          <li key={s.id}>{s.body}</li>
        ))}
      </ol>
      <Link href={`/cook/${recipe.id}`}>Start cooking</Link>
    </article>
  );
}
