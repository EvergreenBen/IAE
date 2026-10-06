import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config";
import { googleAuth } from "./auth/google";
import { requireSession } from "./auth/middleware";
import { recipes } from "./recipes/routes";
import { search } from "./search";
import { uploads } from "./uploads/presign";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", googleAuth);
app.route("/search", search);

// Everything below requires a signed-in user.
app.use("/recipes/*", requireSession);
app.use("/uploads/*", requireSession);
app.route("/recipes", recipes);
app.route("/uploads", uploads);

serve({ fetch: app.fetch, port: config.PORT });
