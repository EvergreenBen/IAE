// Realistic contents and plain-language explanations for the mock "Recipe Box"
// project, so the lens reads like a real codebase in browser dev mode.
// Values that look like secrets are fake.

export const SAMPLE_FILE_TEXT: Record<string, string> = {
  'apps/api/.env': `# ── Recipe Box API · local ──

# Postgres. Drizzle and the session store both read this.
DATABASE_URL=postgres://recipe:recipe@localhost:5432/recipebox
# Connections per API process
DATABASE_POOL_MAX=10

# ── Google sign-in ──
GOOGLE_CLIENT_ID=184467-k2v9recipebox.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-fake-7hQm2xR4vB9nLp0sKd3f
# Where Google sends people after they sign in
OAUTH_REDIRECT_URL=http://localhost:3000/auth/callback

# ── Sessions ──
SESSION_SECRET=8f1d9c2b7e4a6f03c5b2d9e8a1f47c6e
# Days a session lasts without activity
SESSION_TTL_DAYS=30

# ── Photos ──
S3_BUCKET=recipe-box-images
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAFAKEEXAMPLE7Q2R
AWS_SECRET_ACCESS_KEY=fake/wJalrXUtnFEMIK7MDENGbPxRfiCY

# ── Email ──
RESEND_API_KEY=re_fake_4kTq9mVx8hJ2nB7cLw3P
`,

  'apps/api/src/auth/session.ts': `import { and, eq, gt } from 'drizzle-orm';
import { db } from '../../db';
import { sessions } from '../../db/schema';
import { config } from '../config';

const DAY = 86_400_000;

/** A fresh session for someone who just signed in with Google. */
export async function createSession(userId: string) {
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * DAY);
  const [row] = await db.insert(sessions).values({ userId, expiresAt }).returning();
  return row;
}

/** The session behind a cookie, if it exists and hasn't expired. */
export async function findSession(id: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/**
 * Sliding expiry: every authenticated request pushes the window forward,
 * so people who cook every week never get signed out.
 */
export async function rotateSession(id: string) {
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * DAY);
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
}

export async function endSession(id: string) {
  await db.delete(sessions).where(eq(sessions.id, id));
}
`,

  'apps/api/src/auth/middleware.ts': `import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { findSession, rotateSession } from './session';

export const SESSION_COOKIE = 'rb_session';

/** Rejects requests without a valid session, and keeps live sessions fresh. */
export const requireSession: MiddlewareHandler = async (c, next) => {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return c.json({ error: 'Sign in to continue' }, 401);

  const session = await findSession(id);
  if (!session) return c.json({ error: 'Your session has ended' }, 401);

  c.set('userId', session.userId);
  await rotateSession(session.id);
  await next();
};
`,

  'apps/api/src/config.ts': `import { z } from 'zod';

// Everything the API reads from .env, validated once at startup.
const Env = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  OAUTH_REDIRECT_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  S3_BUCKET: z.string(),
  S3_REGION: z.string().default('us-east-1'),
  RESEND_API_KEY: z.string().optional(),
});

const env = Env.parse(process.env);

export const config = {
  databaseUrl: env.DATABASE_URL,
  poolMax: env.DATABASE_POOL_MAX,
  google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUrl: env.OAUTH_REDIRECT_URL },
  sessionSecret: env.SESSION_SECRET,
  sessionTtlDays: env.SESSION_TTL_DAYS,
  s3: { bucket: env.S3_BUCKET, region: env.S3_REGION },
  resendKey: env.RESEND_API_KEY,
} as const;
`,

  'apps/api/src/index.ts': `import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { authRoutes } from './auth/google';
import { requireSession } from './auth/middleware';
import { recipeRoutes } from './recipes/routes';
import { searchRoutes } from './search';

const app = new Hono();

app.use('*', logger());
app.route('/auth', authRoutes);

app.use('/recipes/*', requireSession);
app.route('/recipes', recipeRoutes);
app.route('/search', searchRoutes);

app.get('/health', (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: 8787 });
console.log('Recipe Box API on :8787');
`,

  'apps/api/src/recipes/scale.ts': `import type { Ingredient } from './parse-ingredients';

const NICE_FRACTIONS: [number, string][] = [
  [0.25, '¼'],
  [0.33, '⅓'],
  [0.5, '½'],
  [0.66, '⅔'],
  [0.75, '¾'],
];

/** Scale a recipe from \`from\` servings to \`to\` servings. */
export function scale(ingredients: Ingredient[], from: number, to: number): Ingredient[] {
  const factor = to / from;
  return ingredients.map((i) => (i.quantity == null ? i : { ...i, quantity: round(i.quantity * factor) }));
}

function round(n: number): number {
  // Kitchens don't measure 0.37 cups. Snap to the nearest quarter.
  return Math.round(n * 4) / 4;
}

export function pretty(n: number): string {
  const whole = Math.floor(n);
  const frac = n - whole;
  const nice = NICE_FRACTIONS.find(([v]) => Math.abs(v - frac) < 0.05)?.[1] ?? '';
  return whole ? \`\${whole}\${nice}\` : nice || String(n);
}
`,

  'apps/api/db/schema.ts': `import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  servings: integer('servings').default(2).notNull(),
  body: text('body').notNull(),
  photoKey: text('photo_key'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (t) => [index('sessions_expires_at_idx').on(t.expiresAt)],
);
`,

  'apps/api/db/migrations/0002_sessions.sql': `-- Sessions live in Postgres so signing out works everywhere at once.
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
`,

  'apps/web/lib/query.ts': `import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

/** fetch() with the session cookie and a readable error. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(\`\${API}\${path}\`, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? \`Request failed (\${res.status})\`);
  }
  return res.json() as Promise<T>;
}
`,

  'apps/web/components/RecipeCard.tsx': `import Image from 'next/image';
import Link from 'next/link';
import type { Recipe } from '../lib/types';

export function RecipeCard({ recipe }: { recipe: Recipe }) {
  return (
    <Link href={\`/recipe/\${recipe.id}\`} className="recipe-card">
      {recipe.photoUrl && <Image src={recipe.photoUrl} alt="" width={320} height={200} />}
      <h3>{recipe.title}</h3>
      <p>
        Serves {recipe.servings} · {recipe.minutes} min
      </p>
    </Link>
  );
}
`,

  'apps/jobs/digest/README.md': `# Weekly digest

Every Sunday at 9am local time, send each cook a short email:

- the three recipes they cooked most this week
- one new recipe from someone they follow
- a reminder of anything left in their shopping list

Not built yet. Sending goes through **Resend**; the template lives in \`templates/digest.tsx\`.
`,

  'README.md': `# Recipe Box

Save the recipes you actually cook, scale them for tonight, and keep your phone awake while you do.

## Run it

\`\`\`bash
pnpm install
pnpm db:migrate
pnpm dev        # web on :3000, api on :8787
\`\`\`

Copy \`apps/api/.env.example\` to \`apps/api/.env\` and fill in the Google client first.
`,

  'package.json': `{
  "name": "recipe-box",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "db:migrate": "pnpm --filter api drizzle-kit migrate",
    "test": "vitest run"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
`,
};

/** Plain-language explanations, as the engine's explainFile would give them. */
export const SAMPLE_EXPLAIN: Record<string, string> = {
  'apps/api/.env':
    "The API's private settings: how to reach Postgres, the Google sign-in credentials, the secret that signs session cookies, and the keys for photo storage and email.\n\nNothing here is committed to git. config.ts reads it once when the API starts and refuses to boot if something is missing.",
  'apps/api/src/config.ts':
    "Reads .env when the API starts, checks every value has the right shape, and hands the rest of the code a typed config object.\n\nIf a setting is missing or malformed the API stops right away, rather than failing later in the middle of a request.",
  'apps/api/src/auth/session.ts':
    "Creates, finds, refreshes and ends sign-in sessions. Each session is a row in Postgres with an expiry date.\n\nEvery request from a signed-in person pushes that expiry forward, so regular cooks stay signed in and abandoned sessions quietly run out.",
  'apps/api/src/auth/middleware.ts':
    'Stands in front of every recipe route. It reads the session cookie, checks the session is still valid, remembers who is asking, and turns everyone else away with a 401.',
  'apps/api/src/index.ts': 'Starts the API server and wires the routes together: sign-in, recipes (behind the session check) and search.',
  'apps/api/db/schema.ts': 'Describes the three tables the app keeps in Postgres: users, their recipes, and sign-in sessions. Drizzle generates migrations and typed queries from it.',
  'apps/api/src/recipes/scale.ts':
    'Scales a recipe up or down for a different number of servings, then rounds quantities to amounts a kitchen can actually measure, like ¼ or ⅔ cup.',
  'apps/web/lib/query.ts': "The web app's data plumbing: one shared query cache, and a small fetch helper that sends the session cookie and turns API errors into readable messages.",
  'apps/web/components/RecipeCard.tsx': 'The card shown in recipe grids: photo, title, servings and time, linking to the full recipe.',
};
