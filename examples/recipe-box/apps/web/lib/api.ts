import { sessionHeader } from "./session";

const BASE = process.env.API_URL ?? "http://localhost:8787";

export type Ingredient = { id: string; quantity: number | null; unit: string | null; name: string };
export type Step = { id: string; position: number; body: string; timerSeconds: number | null };
export type Recipe = {
  id: string;
  title: string;
  servings: number;
  thumbnailUrl: string | null;
  ingredients: Ingredient[];
  steps: Step[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await sessionHeader()), ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

export const listRecipes = (q?: string) =>
  request<Recipe[]>(q ? `/search?q=${encodeURIComponent(q)}` : "/recipes");
export const getRecipe = (id: string, servings?: number) =>
  request<Recipe>(`/recipes/${id}${servings ? `?servings=${servings}` : ""}`);
export const createRecipe = (body: { title: string; servings: number; ingredients: string[]; steps: string[] }) =>
  request<Recipe>("/recipes", { method: "POST", body: JSON.stringify(body) });
export const getUploadUrl = (contentType: string) =>
  request<{ url: string; key: string }>("/uploads/presign", { method: "POST", body: JSON.stringify({ contentType }) });
export const getMe = () => request<{ id: string; email: string; name: string }>("/auth/me");
