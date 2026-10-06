import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { findSession } from "./session";

type Env = { Variables: { userId: string } };

export const requireSession = createMiddleware<Env>(async (c, next) => {
  const id = getCookie(c, "rb_session");
  const session = id ? await findSession(id) : null;
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", session.userId);
  await next();
});
