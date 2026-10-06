// A tiny fuzzy scorer for the palette. No dependencies.
//
// Every query character must appear in order. Matches score higher when they
// are consecutive, start a word (after space / - _ . or a camelCase hump), or
// start the string. Gaps and long targets cost a little. Whitespace splits the
// query into terms that must all match (in any order).
//
// A match made mostly of stray letters (neither continuing a run nor starting
// a word) is rejected: "sess" should find session.ts, not s…e…s…s scattered
// through apps/api/src/recipes/scale.ts.

export interface FuzzyMatch {
  score: number;
  /** Indices into the target that matched, ascending. */
  indices: number[];
}

const isSep = (c: string) => c === ' ' || c === '/' || c === '-' || c === '_' || c === '.' || c === ':' || c === '›';
const isUpper = (c: string) => c >= 'A' && c <= 'Z';
const isLower = (c: string) => c >= 'a' && c <= 'z';

function wordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  return isSep(prev) || (isUpper(target[i]) && isLower(prev));
}

/** Score one term (no whitespace) against the target. */
function scoreTerm(term: string, target: string, lower: string, maxStray: number | undefined): FuzzyMatch | null {
  if (!term) return { score: 0, indices: [] };
  if (term.length > target.length) return null;

  // Greedy forward pass that prefers word starts: for each query char, look
  // ahead for a word-start occurrence before the next plain occurrence would
  // break a run.
  const indices: number[] = [];
  let from = 0;
  for (let q = 0; q < term.length; q++) {
    const c = term[q];
    const next = lower.indexOf(c, from);
    if (next === -1) return null;
    let pick = next;
    const continuesRun = indices.length > 0 && next === indices[indices.length - 1] + 1;
    if (!continuesRun && !wordStart(target, next)) {
      // A later word-start occurrence reads better ("ss" → "Session Store").
      for (let k = next + 1; k < lower.length; k++) {
        if (lower[k] === c && wordStart(target, k) && canFinish(term, q + 1, lower, k + 1)) {
          pick = k;
          break;
        }
      }
    }
    indices.push(pick);
    from = pick + 1;
  }

  let score = 0;
  let stray = 0;
  for (let n = 0; n < indices.length; n++) {
    const i = indices[n];
    const run = n > 0 && i === indices[n - 1] + 1;
    const start = wordStart(target, i);
    score += 1;
    if (run) score += 5;
    if (start) score += i === 0 ? 8 : 6;
    if (!run && !start) stray++;
    if (n > 0) score -= Math.min(i - indices[n - 1] - 1, 6) * 0.4;
  }
  if (stray > (maxStray ?? Math.max(1, Math.floor(term.length / 3)))) return null;
  if (lower.startsWith(term)) score += 10;
  else if (lower.includes(term)) score += 4;
  if (lower === term) score += 12;
  score -= Math.min(target.length, 80) * 0.05;
  return { score, indices };
}

function canFinish(term: string, q: number, lower: string, from: number): boolean {
  for (let k = q; k < term.length; k++) {
    const at = lower.indexOf(term[k], from);
    if (at === -1) return false;
    from = at + 1;
  }
  return true;
}

/**
 * Fuzzy-match `query` against `target`. Null when it doesn't match.
 * `maxStray` caps letters that neither continue a run nor start a word
 * (default: one per three query letters; 0 for strict, e.g. keywords).
 */
export function fuzzy(query: string, target: string, maxStray?: number): FuzzyMatch | null {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, indices: [] };
  const lower = target.toLowerCase();
  let score = 0;
  const all = new Set<number>();
  for (const t of terms) {
    const m = scoreTerm(t, target, lower, maxStray);
    if (!m) return null;
    score += m.score;
    for (const i of m.indices) all.add(i);
  }
  return { score, indices: [...all].sort((a, b) => a - b) };
}

/**
 * Score a path, preferring matches in the file name. Indices refer to the full
 * path so the caller can highlight either part.
 */
export function fuzzyPath(query: string, path: string): FuzzyMatch | null {
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const inBase = fuzzy(query, base);
  const inPath = fuzzy(query, path);
  if (inBase && (!inPath || inBase.score + 6 >= inPath.score)) {
    return { score: inBase.score + 6, indices: inBase.indices.map((i) => i + slash + 1) };
  }
  return inPath;
}

/** Split text into runs for highlighting: [text, matched][]. */
export function highlightRuns(text: string, indices: number[], offset = 0): [string, boolean][] {
  const set = new Set(indices.map((i) => i - offset));
  const runs: [string, boolean][] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last[1] === hit) last[0] += text[i];
    else runs.push([text[i], hit]);
  }
  return runs;
}
