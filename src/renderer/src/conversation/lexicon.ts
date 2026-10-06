// Instant, local architecture autocomplete. While the user types or speaks,
// common architecture words become ghost proposals before the sketch model
// answers ("every word moves the map"). Pure: no DOM, no store.
//
// Keys are slug(label) so they line up with the sketcher's proposals and with
// the node the lead eventually commits; that is what lets a ghost *become* the
// node instead of flickering.

import { slug } from '@shared/map';
import type { ArchMap, ArchNode, GhostProposal, NodeKind } from '@shared/model';

/** Where a proposal sits: an existing node matched by label first, then by kind. */
type Pref = { label?: RegExp; kind?: NodeKind };

interface Concept {
  label: string;
  kind: NodeKind;
  /** Whole-word patterns (regex source, matched case-insensitively). Spaces match spaces or hyphens. */
  words: string[];
  /** Concepts in one group compete: a specific one ("Postgres") hides the generic one ("Database"). */
  group?: string;
  generic?: boolean;
  confidence: number;
  /** Likely parent (→ nearNodeId). */
  parent?: Pref[];
  /** Likely connection (→ connectsTo). */
  link?: Pref[];
}

// ── Placement preferences ────────────────────────────────────────────────────

const API: Pref[] = [{ label: /^(api|backend|server)\b|\b(api|backend)$/i, kind: 'service' }, { kind: 'service' }];
const DATA: Pref[] = [{ label: /^(data|storage|persistence)$/i }];
const AUTH: Pref[] = [{ label: /^(auth|login|sign[ -]?in|identity|accounts?)$/i }, ...API];
const BILLING: Pref[] = [{ label: /^(billing|payments?|checkout)$/i }, ...API];
const NOTIFY: Pref[] = [{ label: /notification|email|mail/i }, ...API];
const SEARCH: Pref[] = [{ label: /search/i }, ...API];
const WEB: Pref[] = [{ label: /^(web|web app|frontend|site|website)$/i, kind: 'client' }, { kind: 'client' }];

const mod = (label: string, words: string[], confidence = 0.7, extra: Partial<Concept> = {}): Concept => ({
  label,
  kind: 'module',
  words,
  confidence,
  parent: API,
  ...extra,
});
const ext = (label: string, words: string[], link: Pref[], confidence = 0.85, extra: Partial<Concept> = {}): Concept => ({
  label,
  kind: 'external',
  words,
  confidence,
  link,
  ...extra,
});
const data = (label: string, words: string[], confidence = 0.8, extra: Partial<Concept> = {}): Concept => ({
  label,
  kind: 'data',
  words,
  confidence,
  parent: DATA,
  link: API,
  ...extra,
});
const client = (label: string, words: string[], confidence = 0.75, extra: Partial<Concept> = {}): Concept => ({
  label,
  kind: 'client',
  words,
  confidence,
  link: API,
  ...extra,
});
const infra = (label: string, words: string[], confidence = 0.75, extra: Partial<Concept> = {}): Concept => ({
  label,
  kind: 'infra',
  words,
  confidence,
  ...extra,
});

// ── The lexicon ──────────────────────────────────────────────────────────────

export const CONCEPTS: Concept[] = [
  // Identity
  mod('Auth', ['auth', 'authentication', 'log ?ins?', 'logging in', 'sign ?ins?', 'signing in', 'sign ?ups?', 'user accounts?', 'accounts', 'passwords?', 'oauth', 'sso', 'single sign on', 'magic links?', 'sessions?', '2fa', 'mfa', 'two factor'], 0.75),
  ext('Google OAuth', ['sign ?in with google', 'log ?in with google', 'google (?:sign ?in|log ?in|oauth|auth|accounts?)', 'continue with google'], AUTH, 0.85, { group: 'idp' }),
  ext('GitHub OAuth', ['sign ?in with github', 'log ?in with github', 'github (?:sign ?in|log ?in|oauth|auth)'], AUTH, 0.85, { group: 'idp' }),
  ext('Apple Sign In', ['sign ?in with apple', 'apple (?:sign ?in|log ?in|id)'], AUTH, 0.85, { group: 'idp' }),
  ext('Clerk', ['clerk'], AUTH, 0.75),
  ext('Auth0', ['auth0', 'auth zero'], AUTH),
  mod('Permissions', ['permissions?', 'roles?', 'rbac', 'access control', 'acls?'], 0.65, { parent: AUTH }),
  mod('Teams', ['teams', 'organi[sz]ations?', 'orgs?', 'multi ?tenan(?:t|cy)'], 0.6),
  mod('Profiles', ['profiles?', 'user profiles?', 'avatars?'], 0.6),
  mod('Invites', ['invites?', 'invitations?', 'invite links?', 'share links?', 'sharing links?'], 0.65),

  // Data
  data('Postgres', ['postgres(?:ql)?', 'psql', 'neon'], 0.9, { group: 'db' }),
  data('MySQL', ['mysql', 'mariadb', 'planetscale'], 0.9, { group: 'db' }),
  data('SQLite', ['sqlite', 'libsql', 'turso'], 0.9, { group: 'db' }),
  data('MongoDB', ['mongo(?:db)?', 'mongoose'], 0.9, { group: 'db' }),
  data('DynamoDB', ['dynamo(?:db)?'], 0.9, { group: 'db' }),
  data('Supabase', ['supabase'], 0.85, { group: 'db' }),
  data('Firebase', ['firebase', 'firestore'], 0.85, { group: 'db' }),
  data('Database', ['databases?', 'dbs?', 'datastores?', 'data stores?', 'sql', 'persist(?:ence)?'], 0.65, { group: 'db', generic: true }),
  data('Redis', ['redis', 'valkey', 'upstash'], 0.85, { group: 'cache' }),
  data('Cache', ['cach(?:e|es|ed|ing)', 'memcached?'], 0.65, { group: 'cache', generic: true }),
  data('Pinecone', ['pinecone'], 0.85, { group: 'vector' }),
  data('Vector Store', ['vector (?:dbs?|databases?|stores?|search|index)', 'embeddings?', 'pgvector', 'weaviate', 'qdrant', 'chroma(?:db)?', 'rag', 'semantic search'], 0.75, { group: 'vector', generic: true }),

  // Search
  mod('Search', ['search(?:ing|es)?', 'full text', 'searchable', 'find (?:by|anything)'], 0.65, { group: 'search', generic: true }),
  data('Elasticsearch', ['elastic ?search', 'opensearch'], 0.85, { group: 'search', parent: SEARCH }),
  ext('Algolia', ['algolia'], SEARCH, 0.85, { group: 'search' }),
  data('Meilisearch', ['meili ?search', 'meili'], 0.85, { group: 'search', parent: SEARCH }),
  data('Typesense', ['typesense'], 0.85, { group: 'search', parent: SEARCH }),

  // Files and media
  data('File Storage', ['(?:file|blob|object) storage', 'storage', 'buckets?', 'store (?:the )?files'], 0.6, { group: 'storage', generic: true }),
  data('S3', ['s3', 'aws s3', 'amazon s3'], 0.85, { group: 'storage' }),
  data('R2', ['cloudflare r2', 'r2'], 0.85, { group: 'storage' }),
  data('Images', ['images?', 'photos?', 'pictures?', 'thumbnails?'], 0.6, { group: 'images', generic: true }),
  ext('Cloudinary', ['cloudinary', 'imgix'], API, 0.85, { group: 'images' }),
  mod('Uploads', ['uploads?', 'uploading', 'uploaded', 'file uploads?', 'attachments?'], 0.65),
  infra('CDN', ['cdns?', 'cloudfront', 'edge cach(?:e|ing)'], 0.75),
  {
    label: 'Video',
    kind: 'service',
    words: ['videos?', 'video (?:calls?|chat|streaming|uploads?)', 'live ?stream(?:s|ing)?', 'webrtc', 'mux'],
    confidence: 0.6,
    link: API,
  },
  mod('Exports', ['pdfs?', 'csv exports?', 'export to (?:csv|pdf|excel)', 'printable'], 0.55),

  // Background work
  {
    label: 'Jobs',
    kind: 'queue',
    words: ['background (?:jobs?|tasks?|work|workers?|processing)', 'jobs', 'workers?', 'job queues?', 'async (?:jobs|tasks|processing)'],
    confidence: 0.7,
    link: API,
    group: 'jobs',
    generic: true,
  },
  { label: 'Queue', kind: 'queue', words: ['queues?', 'message (?:queues?|bus|brokers?)', 'pub ?sub', 'event bus'], confidence: 0.7, link: API, group: 'queue', generic: true },
  { label: 'Kafka', kind: 'queue', words: ['kafka', 'redpanda'], confidence: 0.85, link: API, group: 'queue' },
  { label: 'RabbitMQ', kind: 'queue', words: ['rabbit ?mq', 'amqp'], confidence: 0.85, link: API, group: 'queue' },
  { label: 'SQS', kind: 'queue', words: ['sqs'], confidence: 0.85, link: API, group: 'queue' },
  {
    label: 'Scheduler',
    kind: 'queue',
    words: ['cron(?: jobs?)?', 'crons', 'scheduled (?:jobs?|tasks?|emails?)', 'nightly', 'every (?:night|morning|day|hour|week|monday)', '(?:daily|weekly) (?:digests?|emails?|summar(?:y|ies)|reports?)'],
    confidence: 0.7,
    link: API,
  },
  mod('Webhooks', ['web ?hooks?'], 0.8, { parent: BILLING }),

  // Money
  mod('Billing', ['payments?', 'billing', 'subscriptions?', 'checkout', 'invoices?', 'invoicing', 'pricing (?:plans?|tiers?)', 'paid (?:plans?|tiers?)', 'refunds?', 'paywall', 'credit cards?', 'charge (?:users|customers|people)'], 0.75),
  ext('Stripe', ['stripe(?: checkout| billing)?'], BILLING, 0.9, { group: 'payproc' }),
  ext('PayPal', ['paypal'], BILLING, 0.9, { group: 'payproc' }),
  ext('Paddle', ['paddle'], BILLING, 0.8, { group: 'payproc' }),
  ext('Lemon Squeezy', ['lemon ?squeezy'], BILLING, 0.9, { group: 'payproc' }),
  mod('Payouts', ['payouts?', 'stripe connect', 'pay (?:out|sellers|creators|hosts|drivers)', 'marketplace payments', 'split payments'], 0.75, { parent: BILLING }),
  mod('Orders', ['orders', 'order history', 'place an order', 'purchases'], 0.65),
  mod('Cart', ['(?:shopping )?carts?', 'baskets?'], 0.65),
  mod('Inventory', ['inventory', 'stock levels?', 'warehouses?'], 0.7),
  mod('Shipping', ['shipping', 'shipments?', 'fulfil?lment', 'tracking numbers?'], 0.6),

  // Talking to people
  ext('Email', ['e ?mails?', 'emailing', 'newsletters?', 'transactional emails?'], NOTIFY, 0.65, { group: 'email', generic: true }),
  ext('Resend', ['resend'], NOTIFY, 0.85, { group: 'email' }),
  ext('SendGrid', ['send ?grid'], NOTIFY, 0.9, { group: 'email' }),
  ext('Postmark', ['postmark'], NOTIFY, 0.9, { group: 'email' }),
  ext('Mailgun', ['mailgun'], NOTIFY, 0.9, { group: 'email' }),
  ext('Amazon SES', ['ses', 'amazon ses', 'aws ses'], NOTIFY, 0.85, { group: 'email' }),
  ext('SMS', ['sms', 'text messages?', 'texting'], NOTIFY, 0.65, { group: 'sms', generic: true }),
  ext('Twilio', ['twilio'], NOTIFY, 0.9, { group: 'sms' }),
  {
    label: 'Notifications',
    kind: 'service',
    words: ['notifications?', 'notify(?:ing)?', 'push notifications?', 'push alerts?', 'reminders?'],
    confidence: 0.7,
    parent: API,
  },
  mod('Chat', ['chat(?:s|ting)?', 'messaging', 'direct messages?', 'dms?', 'inbox'], 0.65),
  {
    label: 'Realtime',
    kind: 'service',
    words: ['real ?time', 'web ?sockets?', 'socket ?io', 'live (?:updates?|cursors?|collaboration|sync|data|scores?|location)', 'presence', 'multiplayer', 'collaborative editing', 'sse', 'server sent events'],
    confidence: 0.7,
    link: API,
  },
  ext('Pusher', ['pusher', 'ably'], API, 0.85),
  ext('Liveblocks', ['liveblocks'], API, 0.85),
  { label: 'Offline Sync', kind: 'service', words: ['offline(?: first| mode| support| sync)?', 'local first', 'sync(?:ing|s)? across devices'], confidence: 0.6, link: API },

  // Clients
  client('Web App', ['web ?apps?', 'websites?', 'web ?sites?', 'front ?ends?', 'next ?js', 'react (?:app|frontend|front ?end|site|ui|spa)', 'react ?js', 'vue(?: ?js)?', 'svelte(?:kit)?', 'nuxt', 'remix', 'angular', 'astro', 'web (?:ui|client|version)', 'in the browser'], 0.7),
  client('Mobile App', ['mobile(?: apps?)?', 'ios', 'android', 'iphone', 'ipad', 'app store', 'play store', 'react native', 'expo', 'swift ?ui', 'flutter'], 0.8),
  client('Desktop App', ['desktop apps?', 'electron', 'tauri', 'mac apps?', 'windows apps?'], 0.75),
  client('Admin Panel', ['admins?', 'admin (?:panel|dashboard|console|area|tools?|ui|pages?|portal|site)', 'back ?office', 'internal tools?'], 0.75, { group: 'admin' }),
  client('Dashboard', ['dashboards?'], 0.6, { group: 'admin', generic: true }),
  client('Landing Page', ['landing pages?', 'marketing (?:site|website|pages?)', 'wait ?list'], 0.7),
  client('CLI', ['cli', 'command line(?: tool)?', 'terminal app'], 0.75),
  client('Browser Extension', ['(?:browser|chrome|firefox) extensions?'], 0.85),
  ext('CMS', ['cms', 'headless cms', 'content management', 'sanity', 'contentful', 'strapi'], API, 0.7),
  mod('Blog', ['blogs?', 'blog posts?'], 0.6),

  // The backend itself
  { label: 'API', kind: 'service', words: ['apis?', 'back ?ends?', 'servers?', 'rest ?apis?', 'restful', 'endpoints?', 'express', 'hono', 'fastapi', 'django', 'rails', 'flask', 'nest ?js', 'node (?:server|backend|api)'], confidence: 0.75, group: 'api', generic: true },
  { label: 'GraphQL API', kind: 'service', words: ['graph ?ql', 'apollo'], confidence: 0.85, group: 'api' },
  infra('API Gateway', ['api gateway', 'gateway', 'reverse proxy', 'nginx', 'load balanc(?:er|ers|ing)'], 0.7),
  mod('Rate Limiter', ['rate ?limit(?:s|ing|er|ed)?', 'throttl(?:e|ing)', 'abuse protection', 'quotas?'], 0.75),
  { label: 'Feature Flags', kind: 'config', words: ['feature (?:flags?|toggles?)', 'a/?b tests?', 'experiments?', 'launch ?darkly'], confidence: 0.75, parent: API },
  { label: 'Config', kind: 'config', words: ['config(?:uration)?', 'env(?:ironment)? (?:vars?|variables)', '\\.env', 'secrets?', 'api keys?'], confidence: 0.6, parent: API },

  // AI
  { label: 'AI Assistant', kind: 'ai', words: ['ai', 'llms?', 'claude', 'anthropic', 'gpt(?:-?\\d+o?)?', 'openai', 'chat ?gpt', 'chat ?bots?', 'ai (?:assistant|chat|features?|agents?|model)', 'assistant', 'copilot', 'language models?', 'gen(?:erative)? ai'], confidence: 0.75, link: API },
  { label: 'Speech', kind: 'ai', words: ['speech to text', 'transcri(?:be|bes|bing|ption|ptions)', 'voice (?:input|notes?|commands?|assistant)', 'whisper', 'text to speech', 'tts'], confidence: 0.65, link: API },
  { label: 'Recommendations', kind: 'ai', words: ['recommendations?', 'recommender', 'recommendation engine', 'personali[sz]ed (?:feed|suggestions|recommendations)', 'for you feed'], confidence: 0.7, link: API },
  mod('Moderation', ['moderation', 'content moderation', 'spam (?:filter|filtering|detection)', 'report (?:abuse|posts?|users?)'], 0.65),

  // Seeing what happens
  infra('Monitoring', ['monitor(?:ing)?', 'observability', 'logs?(?! ?(?:in|out)(?![\\w]))', 'logging', 'tracing', 'uptime', 'alerting', 'error tracking', 'crash report(?:s|ing)?'], 0.65, { group: 'monitoring', generic: true }),
  ext('Sentry', ['sentry', 'bugsnag', 'rollbar'], API, 0.9, { group: 'monitoring' }),
  ext('Datadog', ['datadog', 'new relic', 'grafana', 'prometheus'], API, 0.85, { group: 'monitoring' }),
  ext('Analytics', ['analytics', 'metrics', '(?:usage|event|user) tracking', 'funnels?', 'kpis?', 'telemetry'], WEB, 0.7, { group: 'analytics', generic: true }),
  ext('PostHog', ['post ?hog'], WEB, 0.9, { group: 'analytics' }),
  ext('Mixpanel', ['mixpanel'], WEB, 0.9, { group: 'analytics' }),
  ext('Amplitude', ['amplitude'], WEB, 0.8, { group: 'analytics' }),
  ext('Plausible', ['plausible analytics', 'plausible\\.io'], WEB, 0.85, { group: 'analytics' }),
  ext('Google Analytics', ['google analytics', 'ga4'], WEB, 0.9, { group: 'analytics' }),

  // Shipping it
  infra('CI/CD', ['ci', 'ci ?cd', 'cd pipelines?', 'ci pipelines?', 'continuous (?:integration|deploy(?:ment)?s?|delivery)', 'github actions', 'gitlab ci', 'circle ?ci', '(?:deploy|build) pipelines?', 'automated deploys?'], 0.75),
  infra('Hosting', ['hosting', 'hosted', 'deploy(?:s|ed|ing|ment|ments)?', 'production environment', 'staging', 'serverless', 'lambdas?'], 0.55, { group: 'hosting', generic: true }),
  infra('Vercel', ['vercel'], 0.9, { group: 'hosting' }),
  infra('Netlify', ['netlify'], 0.9, { group: 'hosting' }),
  infra('Fly.io', ['fly ?io', 'fly\\.io'], 0.9, { group: 'hosting' }),
  infra('Railway', ['railway'], 0.8, { group: 'hosting' }),
  infra('Heroku', ['heroku'], 0.9, { group: 'hosting' }),
  infra('AWS', ['aws', 'amazon web services', 'ec2', 'ecs', 'fargate'], 0.8, { group: 'hosting' }),
  infra('Google Cloud', ['gcp', 'google cloud', 'cloud run'], 0.85, { group: 'hosting' }),
  infra('Azure', ['azure'], 0.85, { group: 'hosting' }),
  infra('Docker', ['docker(?:file)?', 'containers?', 'containeri[sz]ed'], 0.75),
  infra('Kubernetes', ['kubernetes', 'k8s', 'helm'], 0.85),
  infra('Terraform', ['terraform', 'infrastructure as code', 'iac'], 0.8),
  infra('DNS', ['dns', 'custom domains?', 'domain names?'], 0.7),

  // Place
  ext('Maps', ['maps', 'interactive maps?', 'map view', 'on a map', 'geo ?location', 'geocoding', 'geofenc(?:e|es|ing)', 'gps', 'directions', 'location (?:data|sharing|tracking|search)', 'nearby'], WEB, 0.7, { group: 'maps', generic: true }),
  ext('Mapbox', ['mapbox'], WEB, 0.9, { group: 'maps' }),
  ext('Google Maps', ['google maps', 'places api'], WEB, 0.9, { group: 'maps' }),

  // Common product pieces
  mod('Calendar', ['calendars?', 'ical', 'google calendar'], 0.65),
  mod('Bookings', ['bookings?', 'appointments?', 'reservations?'], 0.65),
  mod('Comments', ['comments?', 'commenting', 'replies'], 0.65),
  mod('Feed', ['feeds?', 'activity feeds?', 'news ?feeds?'], 0.6),
  mod('Reviews', ['reviews', 'product reviews?', 'user reviews?', 'ratings?', 'star ratings?', 'upvotes?'], 0.6),
  mod('Polls', ['polls?', 'voting', 'votes?', 'surveys?'], 0.65),
  mod('Onboarding', ['onboarding', 'sign ?up flow', 'welcome flow', 'tutorials?'], 0.6),
  mod('Settings', ['settings (?:page|screen)', 'preferences', 'user settings'], 0.6),
  mod('i18n', ['i18n', 'internationali[sz]ation', 'locali[sz]ation', 'translations?', 'multiple languages', 'multi ?language'], 0.7),
  mod('Audit Log', ['audit (?:logs?|trail)', 'activity log', 'history of changes', 'version history'], 0.7),
];

// ── Matching ─────────────────────────────────────────────────────────────────

const NEGATION = /\b(?:no|not|without|don'?t|doesn'?t|never|skip|instead of|rather than|avoid|drop|remove)\b(?:\s+\S+){0,2}\s*$/i;

interface Compiled {
  concept: Concept;
  re: RegExp;
}

let compiled: Compiled[] | null = null;
function compile(): Compiled[] {
  if (compiled) return compiled;
  compiled = CONCEPTS.map((concept) => {
    const alts = concept.words.map((w) => w.replace(/ \?/g, '[\\s-]*').replace(/ /g, '[\\s-]+'));
    // Lookarounds instead of \b so words like ".env" and "a/b tests" still anchor.
    return { concept, re: new RegExp(`(?<![\\w])(?:${alts.join('|')})(?![\\w])`, 'gi') };
  });
  return compiled;
}

interface Hit {
  concept: Concept;
  index: number;
  count: number;
}

function findHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { concept, re } of compile()) {
    re.lastIndex = 0;
    let first = -1;
    let count = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (NEGATION.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
      if (first === -1) first = m.index;
      count++;
    }
    if (first !== -1) hits.push({ concept, index: first, count });
  }
  // Within a group, a specific concept hides the generic one.
  const specificGroups = new Set(hits.filter((h) => h.concept.group && !h.concept.generic).map((h) => h.concept.group));
  return hits.filter((h) => !(h.concept.generic && specificGroups.has(h.concept.group)));
}

// ── Map awareness ────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function depth(map: ArchMap, n: ArchNode): number {
  let d = 0;
  for (let p = n.parentId; p && map.nodes[p] && d < 32; p = map.nodes[p].parentId) d++;
  return d;
}

/** Labels, ids and tech already on the map, normalised. */
function existingNames(map: ArchMap): Set<string> {
  const names = new Set<string>();
  for (const n of Object.values(map.nodes)) {
    names.add(norm(n.id));
    names.add(norm(n.label));
    for (const t of n.tech ?? []) names.add(norm(t));
  }
  return names;
}

function resolve(map: ArchMap, nodes: ArchNode[], prefs: Pref[] | undefined): string | null {
  if (!prefs) return null;
  for (const p of prefs) {
    const match = nodes.find((n) => (!p.label || p.label.test(n.label)) && (!p.kind || n.kind === p.kind));
    if (match) return match.id;
  }
  return null;
}

export interface LexiconOptions {
  /** Most proposals to return (default 5). */
  limit?: number;
}

/**
 * Words → ghost proposals. Skips anything already on the map (by id, label or
 * tech), respects simple negation ("no database"), and returns proposals in
 * the order they were said.
 */
export function lexiconProposals(text: string, map: ArchMap, opts: LexiconOptions = {}): GhostProposal[] {
  const clean = text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return [];
  const names = existingNames(map);
  // Shallow, ordered nodes first so "near" picks the obvious one.
  const nodes = Object.values(map.nodes).sort((a, b) => depth(map, a) - depth(map, b) || (a.order ?? 99) - (b.order ?? 99) || a.createdAt - b.createdAt);

  const out: GhostProposal[] = [];
  const seen = new Set<string>();
  for (const hit of findHits(clean).sort((a, b) => a.index - b.index)) {
    const { concept } = hit;
    const key = slug(concept.label);
    if (seen.has(key) || names.has(norm(key)) || names.has(norm(concept.label))) continue;
    seen.add(key);
    const nearNodeId = resolve(map, nodes, concept.parent);
    const link = resolve(map, nodes, concept.link);
    out.push({
      key,
      label: concept.label,
      kind: concept.kind,
      nearNodeId,
      connectsTo: link && link !== nearNodeId ? [link] : undefined,
      confidence: Math.min(0.95, concept.confidence + 0.05 * (hit.count - 1)),
      source: 'lexicon',
    });
  }
  return out.slice(0, opts.limit ?? 5);
}

/** True when two proposal lists would draw the same ghosts (avoids store churn). */
export function sameProposals(a: GhostProposal[], b: GhostProposal[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.key === b[i].key && p.nearNodeId === b[i].nearNodeId);
}
