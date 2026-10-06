import { listRecipes } from "@/lib/api";
import { RecipeCard } from "@/components/RecipeCard";

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const recipes = await listRecipes(q);
  return (
    <>
      <form action="/" method="get">
        <input name="q" defaultValue={q} placeholder="Search recipes" />
      </form>
      <section className="grid">
        {recipes.map((r) => (
          <RecipeCard key={r.id} recipe={r} />
        ))}
      </section>
    </>
  );
}
