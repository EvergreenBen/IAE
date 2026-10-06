// Ghosts come from two sketchers (the instant lexicon and the slower model),
// so the same idea often arrives twice: "API" and "API Server", "Redis" and
// "Redis Cache", "Polls" and "Voting System", "Notes Database" when Postgres
// is already on the map. Show each idea once. Pure, so it can be tested.
import type { GhostProposal } from '@shared/model';

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'to', 'with', 'my', 'our']);

/** Words that name the kind of part, not the part: "Voting System" is the voting part. Dropped when something else remains. */
const FILLER = new Set(['system', 'service', 'module', 'manager', 'engine', 'layer', 'feature', 'component']);

/** A generic role and the specific things that fill it. Generic + specific of one role = one idea. */
const ROLES: { generic: string[]; specific: string[] }[] = [
  { generic: ['database'], specific: ['postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'mongo', 'dynamodb', 'supabase', 'firebase', 'firestore', 'neon', 'planetscale', 'mariadb', 'cockroachdb'] },
  { generic: ['cache'], specific: ['redis', 'memcached', 'valkey', 'upstash'] },
  { generic: ['billing'], specific: ['stripe', 'paddle', 'paypal', 'lemon', 'squeezy'] },
  { generic: ['search'], specific: ['elasticsearch', 'algolia', 'meilisearch', 'typesense', 'opensearch'] },
  { generic: ['email'], specific: ['resend', 'sendgrid', 'postmark', 'mailgun', 'ses'] },
  { generic: ['queue', 'job'], specific: ['kafka', 'rabbitmq', 'sqs', 'bullmq'] },
  { generic: ['storage', 'file', 'upload'], specific: ['s3', 'r2', 'gcs', 'blob'] },
  { generic: ['auth'], specific: ['clerk', 'auth0', 'oauth', 'okta'] },
];

/** Near-synonyms, after plurals are folded: "Polls" and "Voting", "Payments" and "Billing", "Login" and "Auth" are one idea. */
const SYNONYM: Record<string, string> = {
  poll: 'poll', voting: 'poll', vote: 'poll', survey: 'poll', ballot: 'poll',
  payment: 'billing', checkout: 'billing', subscription: 'billing', invoice: 'billing', invoicing: 'billing',
  authentication: 'auth', login: 'auth', logon: 'auth', signin: 'auth', signup: 'auth',
  db: 'database', datastore: 'database',
  mail: 'email', mailer: 'email',
  caching: 'cache',
  notify: 'notification', notifier: 'notification',
  messaging: 'chat',
  frontend: 'web', website: 'web',
  backend: 'api',
};

/** Names that are already exact (products, acronyms): never folded. */
const EXACT = new Set(ROLES.flatMap((r) => r.specific));

const fold = (t: string) => {
  const one = !EXACT.has(t) && t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
  return SYNONYM[one] ?? one;
};

export const tokensOf = (label: string): string[] => {
  const words = (label.toLowerCase().replace(/\b(log|sign)[\s-]?(in|on|up)\b/g, '$1$2').match(/[a-z0-9]+/g) ?? []).filter((t) => !STOP.has(t)).map(fold);
  const core = words.filter((t) => !FILLER.has(t));
  return [...new Set(core.length ? core : words)];
};

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
 * another ghost. Between two ghosts the more specific one stays, then the one
 * already showing (`shown` keys: no relabelling under the user's eyes), then
 * the more confident; the input order breaks ties so the result is stable.
 */
export function dedupeGhosts(ghosts: GhostProposal[], existing: { label: string; tech?: string[] }[], shown?: ReadonlySet<string>): GhostProposal[] {
  const onMap = existing.flatMap((n) => [tokensOf(n.label), ...(n.tech ?? []).map(tokensOf)]).filter((t) => t.length);
  const fresh = ghosts.filter((g) => !onMap.some((t) => sameIdea(tokensOf(g.label), t)));
  const up = (g: GhostProposal) => (shown?.has(g.key) ? 1 : 0);
  const ranked = fresh
    .map((g, i) => ({ g, i, t: tokensOf(g.label) }))
    .sort((a, b) => specificity(b.t) - specificity(a.t) || up(b.g) - up(a.g) || b.g.confidence - a.g.confidence || a.i - b.i);
  const kept: typeof ranked = [];
  for (const r of ranked) if (!kept.some((k) => sameIdea(k.t, r.t))) kept.push(r);
  return kept.sort((a, b) => a.i - b.i).map((k) => k.g);
}
