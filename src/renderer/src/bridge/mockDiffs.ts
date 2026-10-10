// What the mock builders "changed" in the Recipe Box sample: each file's diff
// against the last commit, and the new files they wrote. The crew list's counts
// come from these same diffs, so the numbers and the lens always agree.

import type { DiffHunk, DiffLine, FileChange, FileDiff } from '@shared/model';
import { SAMPLE_FILE_TEXT } from './mockFiles';

/** A hunk from lines written the way git prints them: ' ' context, '+' added, '-' removed. */
function hunk(oldStart: number, newStart: number, body: string[], section?: string): DiffHunk {
  let o = oldStart;
  let n = newStart;
  const lines = body.map((raw): DiffLine => {
    const text = raw.slice(1);
    if (raw[0] === '+') return { kind: 'add', text, newNo: n++ };
    if (raw[0] === '-') return { kind: 'del', text, oldNo: o++ };
    return { kind: 'ctx', text, oldNo: o++, newNo: n++ };
  });
  return { oldStart, oldLines: o - oldStart, newStart, newLines: n - newStart, ...(section ? { section } : {}), lines };
}

function modified(path: string, hunks: DiffHunk[]): FileDiff {
  const count = (k: DiffLine['kind']) => hunks.reduce((t, h) => t + h.lines.filter((l) => l.kind === k).length, 0);
  return { path, status: 'modified', added: count('add'), removed: count('del'), hunks };
}

function created(path: string, text: string): FileDiff {
  const lines = text.replace(/\n$/, '').split('\n');
  return { path, status: 'added', added: lines.length, removed: 0, hunks: [hunk(0, 1, lines.map((l) => `+${l}`))] };
}

const COOK_PAGE = `'use client';

import { useEffect } from 'react';
import { useRecipe } from '../../../lib/query';
import { IngredientList } from '../../../components/IngredientList';
import { useWakeLock } from './useWakeLock';

/** Cook mode: one step at a time, big type, and the screen stays awake. */
export default function CookPage({ params }: { params: { id: string } }) {
  const recipe = useRecipe(params.id);
  const wake = useWakeLock();

  useEffect(() => {
    void wake.request();
    return () => void wake.release();
  }, [wake]);

  if (!recipe.data) return null;
  return (
    <main className="cook">
      <h1>{recipe.data.title}</h1>
      <IngredientList items={recipe.data.ingredients} />
    </main>
  );
}
`;

const WAKE_LOCK = `import { useMemo } from 'react';

/** Keeps the screen on while someone cooks (the Screen Wake Lock API). */
export function useWakeLock() {
  return useMemo(() => {
    let lock: WakeLockSentinel | null = null;
    return {
      async request() {
        if (!('wakeLock' in navigator)) return;
        lock = await navigator.wakeLock.request('screen').catch(() => null);
      },
      async release() {
        await lock?.release();
        lock = null;
      },
    };
  }, []);
}
`;

/** Files the mock builders write that the sample project doesn't have yet. */
export const CHANGED_FILE_TEXT: Record<string, string> = {
  'apps/web/app/cook/[id]/page.tsx': COOK_PAGE,
  'apps/web/app/cook/[id]/useWakeLock.ts': WAKE_LOCK,
};

const DIFFS: FileDiff[] = [
  modified('apps/api/src/auth/session.ts', [
    hunk(1, 1, ["-import { eq } from 'drizzle-orm';", "+import { and, eq, gt } from 'drizzle-orm';", " import { db } from '../../db';", " import { sessions } from '../../db/schema';", " import { config } from '../config';"]),
    hunk(
      17,
      17,
      [
        '   const [row] = await db',
        '     .select()',
        '     .from(sessions)',
        '-    .where(eq(sessions.id, id))',
        '+    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))',
        '     .limit(1);',
        '   return row ?? null;',
        ' }',
        ' ',
        '+/**',
        '+ * Sliding expiry: every authenticated request pushes the window forward,',
        '+ * so people who cook every week never get signed out.',
        '+ */',
        '+export async function rotateSession(id: string) {',
        '+  const expiresAt = new Date(Date.now() + config.sessionTtlDays * DAY);',
        '+  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));',
        '+}',
        '+',
        ' export async function endSession(id: string) {',
        '   await db.delete(sessions).where(eq(sessions.id, id));',
        ' }',
      ],
      'export async function findSession(id: string) {',
    ),
  ]),
  created('apps/api/db/migrations/0002_sessions.sql', SAMPLE_FILE_TEXT['apps/api/db/migrations/0002_sessions.sql'] ?? ''),
  modified('apps/api/src/auth/middleware.ts', [
    hunk(1, 1, [
      " import type { MiddlewareHandler } from 'hono';",
      " import { getCookie } from 'hono/cookie';",
      "-import { findSession } from './session';",
      "+import { findSession, rotateSession } from './session';",
      ' ',
      " export const SESSION_COOKIE = 'rb_session';",
      ' ',
      '-/** Rejects requests without a valid session. */',
      '+/** Rejects requests without a valid session, and keeps live sessions fresh. */',
      ' export const requireSession: MiddlewareHandler = async (c, next) => {',
      '   const id = getCookie(c, SESSION_COOKIE);',
      "   if (!id) return c.json({ error: 'Sign in to continue' }, 401);",
      ' ',
      '   const session = await findSession(id);',
      "   if (!session) return c.json({ error: 'Your session has ended' }, 401);",
      ' ',
      "   c.set('userId', session.userId);",
      '+  await rotateSession(session.id);',
      '   await next();',
      ' };',
    ]),
  ]),
  modified('apps/web/app/cook/[id]/page.tsx', [
    hunk(1, 1, [
      " 'use client';",
      ' ',
      "+import { useEffect } from 'react';",
      " import { useRecipe } from '../../../lib/query';",
      " import { IngredientList } from '../../../components/IngredientList';",
      "+import { useWakeLock } from './useWakeLock';",
      ' ',
      '-/** Cook mode: one step at a time, big type. */',
      '+/** Cook mode: one step at a time, big type, and the screen stays awake. */',
      ' export default function CookPage({ params }: { params: { id: string } }) {',
      '   const recipe = useRecipe(params.id);',
      '+  const wake = useWakeLock();',
      ' ',
      '+  useEffect(() => {',
      '+    void wake.request();',
      '+    return () => void wake.release();',
      '+  }, [wake]);',
      '+',
      '   if (!recipe.data) return null;',
      '   return (',
      '     <main className="cook">',
    ]),
  ]),
  created('apps/web/app/cook/[id]/useWakeLock.ts', WAKE_LOCK),
];

const BY_PATH = new Map(DIFFS.map((d) => [d.path, d]));

/** The file's changes since the last commit, as the mock tells it. */
export function mockDiff(path: string): FileDiff {
  return BY_PATH.get(path) ?? { path, status: 'unchanged', added: 0, removed: 0, hunks: [] };
}

/** What a builder's edit to `path` adds to its list (nothing for a file the sample doesn't change). */
export function mockChange(path: string, at: number): FileChange | null {
  const d = BY_PATH.get(path);
  if (!d) return null;
  return { path, added: d.added, removed: d.removed, ...(d.status === 'added' ? { created: true } : {}), at };
}
