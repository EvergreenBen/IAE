import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { ingredients, recipes as recipesTable, steps } from "../../db/schema";
import { parseIngredient } from "./parse-ingredients";
import { scaleIngredients } from "./scale";

export const recipes = new Hono<{ Variables: { userId: string } }>();

const createBody = z.object({
  title: z.string().min(1),
  servings: z.number().int().positive(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
});

async function load(id: string) {
  const [recipe] = await db.select().from(recipesTable).where(eq(recipesTable.id, id));
  if (!recipe) return null;
  const ing = await db.select().from(ingredients).where(eq(ingredients.recipeId, id));
  const st = await db.select().from(steps).where(eq(steps.recipeId, id)).orderBy(steps.position);
  return { ...recipe, ingredients: ing, steps: st };
}

recipes.get("/", async (c) => {
  const rows = await db
    .select()
    .from(recipesTable)
    .where(eq(recipesTable.userId, c.get("userId")))
    .orderBy(desc(recipesTable.createdAt));
  return c.json(await Promise.all(rows.map((r) => load(r.id))));
});

recipes.get("/:id", async (c) => {
  const recipe = await load(c.req.param("id"));
  if (!recipe) return c.json({ error: "not found" }, 404);
  const target = Number(c.req.query("servings"));
  if (!target) return c.json(recipe);
  return c.json({ ...recipe, servings: target, ingredients: scaleIngredients(recipe.ingredients, recipe.servings, target) });
});

recipes.post("/", zValidator("json", createBody), async (c) => {
  const body = c.req.valid("json");
  const [recipe] = await db
    .insert(recipesTable)
    .values({ userId: c.get("userId"), title: body.title, servings: body.servings })
    .returning();
  await db.insert(ingredients).values(body.ingredients.map((l) => ({ recipeId: recipe.id, ...parseIngredient(l) })));
  await db.insert(steps).values(body.steps.map((b, i) => ({ recipeId: recipe.id, position: i, body: b })));
  return c.json(await load(recipe.id), 201);
});
