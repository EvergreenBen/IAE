import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { config } from "../config";
import { createSession, findSession } from "./session";

export const googleAuth = new Hono();
const redirectUri = "http://localhost:8787/auth/google/callback";

googleAuth.get("/google", (c) => {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

googleAuth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("missing code", 400);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const info = (await (
    await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${access_token}` },
    })
  ).json()) as { sub: string; email: string; name: string };

  let [user] = await db.select().from(users).where(eq(users.googleId, info.sub));
  if (!user) {
    [user] = await db.insert(users).values({ googleId: info.sub, email: info.email, name: info.name }).returning();
  }

  const sessionId = await createSession(user.id);
  setCookie(c, "rb_session", sessionId, { httpOnly: true, sameSite: "Lax", path: "/" });
  return c.redirect("http://localhost:3000/");
});

googleAuth.get("/me", async (c) => {
  const session = await findSession(getCookie(c, "rb_session") ?? "");
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  return c.json({ id: user.id, email: user.email, name: user.name });
});
