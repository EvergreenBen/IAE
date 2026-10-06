import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/client";
import { sessions } from "../../db/schema";
import { config } from "../config";

const ttlMs = () => config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export async function createSession(userId: string): Promise<string> {
  const id = `${userId}.${randomBytes(24).toString("hex")}`;
  await db.insert(sessions).values({ id, userId, expiresAt: new Date(Date.now() + ttlMs()) });
  return id;
}

export async function findSession(id: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

/** Issue a fresh id and invalidate the old one. */
export async function rotateSession(oldId: string): Promise<string | null> {
  const existing = await findSession(oldId);
  if (!existing) return null;
  await db.delete(sessions).where(eq(sessions.id, oldId));
  return createSession(existing.userId);
}
