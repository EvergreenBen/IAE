import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";

export const search = new Hono();

// Backed by the generated `search` tsvector column on recipes (see 0001_init.sql).
search.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json([]);
  const { rows } = await db.execute(sql`
    SELECT id, title, servings, thumbnail_url AS "thumbnailUrl"
    FROM recipes
    WHERE search @@ websearch_to_tsquery('english', ${q})
    ORDER BY ts_rank(search, websearch_to_tsquery('english', ${q})) DESC
    LIMIT 40
  `);
  return c.json(rows.map((r) => ({ ...r, ingredients: [], steps: [] })));
});
