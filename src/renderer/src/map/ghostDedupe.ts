// Ghosts come from two sketchers (the instant lexicon and the slower model),
// so the same idea often arrives twice: "API" and "API Server", "Redis" and
// "Redis Cache", "Notes Database" when Postgres is already on the map. Show
// each idea once. Pure, so it can be tested.
import type { GhostProposal } from '@shared/model';

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'to', 'with', 'my', 'our']);

/** A generic role and the specific things that fill it. Generic + specific of one role = one idea. */
const ROLES: { generic: string[]; specific: string[] }[] = [
  { generic: ['database', 'db', 'datastore'], specific: ['postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'mongo', 'dynamodb', 'supabase', 'firebase', 'firestore', 'neon', 'planetscale', 'mariadb', 'cockroachdb'] },
  { generic: ['cache', 'caching'], specific: ['redis', 'memcached', 'valkey', 'upstash'] },
  { generic: ['billing', 'payments', 'payment', 'subscriptions'], specific: ['stripe', 'paddle', 'paypal', 'lemon', 'squeezy'] },
  { generic: ['search'], specific: ['elasticsearch', 'algolia', 'meilisearch', 'typesense', 'opensearch'] },
  { generic: ['email', 'mail', 'mailer'], specific: ['resend', 'sendgrid', 'postmark', 'mailgun', 'ses'] },
  { generic: ['queue', 'jobs'], specific: ['kafka', 'rabbitmq', 'sqs', 'bullmq'] },
  { generic: ['storage', 'files', 'uploads'], specific: ['s3', 'r2', 'gcs', 'blob'] },
  { generic: ['auth', 'login', 'signin'], specific: ['clerk', 'auth0', 'oauth', 'okta'] },
];

export const tokensOf = (label: string): string[] => (label.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t));

const subset = (a: string[], b: string[]) => a.length > 0 && a.every((t) => b.includes(t));

/** Is one label the other in different words? */
export function sameIdea(a: string[], b: string[]): boolean {
  if (subset(a, b) || subset(b, a)) return true;
  for (const r of ROLES) {
    const aG = a.some((t) => r.generic.includes(t));
    const bG = b.some((t) => r.generic.includes(t));
    const aS = a.some((t) => r.specific.includes(t));
    const bS = b.some((t) => r.specific.includes(t));
    // One names the role, the other fills it (two different engines are two ideas).
    if ((aG && bS && !aS) || (bG && aS && !bS)) return true;
  }
  return false;
}

/** How specific a label is: a named product beats a generic role; fewer words beat more. */
function specificity(tokens: string[]): number {
  const named = ROLES.some((r) => tokens.some((t) => r.specific.includes(t)));
  return (named ? 10 : 0) - tokens.length * 0.1;
}

/**
 * Drop ghosts that repeat something already on the map (label or tech) or
 * another ghost. Between two ghosts the more specific, then more confident one
 * stays; the input order breaks ties so the result is stable.
 */
export function dedupeGhosts(ghosts: GhostProposal[], existing: { label: string; tech?: string[] }[]): GhostProposal[] {
  const onMap = existing.flatMap((n) => [tokensOf(n.label), ...(n.tech ?? []).map(tokensOf)]).filter((t) => t.length);
  const fresh = ghosts.filter((g) => !onMap.some((t) => sameIdea(tokensOf(g.label), t)));
  const ranked = fresh
    .map((g, i) => ({ g, i, t: tokensOf(g.label) }))
    .sort((a, b) => specificity(b.t) - specificity(a.t) || b.g.confidence - a.g.confidence || a.i - b.i);
  const kept: typeof ranked = [];
  for (const r of ranked) if (!kept.some((k) => sameIdea(k.t, r.t))) kept.push(r);
  return kept.sort((a, b) => a.i - b.i).map((k) => k.g);
}
