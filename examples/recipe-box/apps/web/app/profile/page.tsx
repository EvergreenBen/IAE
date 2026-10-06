import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getMe, listRecipes } from "@/lib/api";
import { RecipeCard } from "@/components/RecipeCard";

export default async function Profile() {
  if (!(await getSession())) redirect("/api/auth/google");
  const [me, recipes] = await Promise.all([getMe(), listRecipes()]);
  return (
    <>
      <h1>{me.name}</h1>
      <p>{me.email}</p>
      <h2>Your recipes</h2>
      <section className="grid">
        {recipes.map((r) => (
          <RecipeCard key={r.id} recipe={r} />
        ))}
      </section>
    </>
  );
}
