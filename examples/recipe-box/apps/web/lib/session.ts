import { cookies } from "next/headers";

export type Session = { id: string; userId: string };

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const id = jar.get("rb_session")?.value;
  if (!id) return null;
  const [userId] = id.split(".");
  return { id, userId };
}

export async function sessionHeader(): Promise<HeadersInit> {
  const session = await getSession();
  return session ? { cookie: `rb_session=${session.id}` } : {};
}
