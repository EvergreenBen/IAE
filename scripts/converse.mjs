#!/usr/bin/env node
// Conversation-quality harness. Drives the REAL engine (real Claude sessions,
// via your Claude Code login) through scripted multi-turn conversations and
// writes a readable transcript per scenario: timings (TTFT, turn time),
// what Archie said, the tools it called (in order), map ops, agenda cards,
// decisions, delegations, builder questions, pulse/silence decisions, and a
// mechanical scorecard against docs/CONVERSATION.md.
//
//   node scripts/converse.mjs climbing            # a. new-project ideation
//   node scripts/converse.mjs stripe              # b. existing repo (recipe-box) → Stripe
//   node scripts/converse.mjs idle                # c. never-idle: build + pulse + ask_architect
//   node scripts/converse.mjs bargein             # d. interrupt mid-reply + follow-up
//   node scripts/converse.mjs resume              # e. close + reopen (needs a prior climbing run: --project DIR)
//   node scripts/converse.mjs sketch              # sketcher latency + proposal quality, then one growing utterance
//                                                 # (--grow-only: just the growing utterance; --no-grow: skip it)
//   node scripts/converse.mjs rename              # lead renamed in Settings mid-session
//   node scripts/converse.mjs recall              # talk past an open card (repeats?), then reopen: who decided what
//   node scripts/converse.mjs climbing --out DIR  # where transcripts go (default: out/converse/<stamp>)
//
// The engine is bundled with esbuild (dependencies external) into out/converse/engine-<pid>.mjs.

import { build } from 'esbuild';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : fallback;
};
const scenarios = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outRoot = resolve(opt('--out', join(repo, 'out/converse', stamp)));
mkdirSync(outRoot, { recursive: true });

const outfile = join(repo, `out/converse/engine-${process.pid}.mjs`);
await build({
  entryPoints: [join(repo, 'src/main/engine/engine.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  outfile,
  logLevel: 'warning',
});
const { Engine } = await import(pathToFileURL(outfile).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (s) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

// ── recorder ────────────────────────────────────────────────────────────────

class Run {
  constructor(name) {
    this.name = name;
    this.dir = join(outRoot, name);
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, 'transcript.txt');
    writeFileSync(this.file, '');
    this.t0 = Date.now();
    this.turns = [];
    this.cur = null;
    this.listeners = new Set();
    this.agenda = new Map();
    this.briefs = [];
    this.builderAsks = [];
    this.lastSayAt = 0;
    this.pendingSay = null;
    this.mapNodes = new Map();
    this.engine = null;
  }

  t() {
    return ((Date.now() - this.t0) / 1000).toFixed(1).padStart(6) + 's';
  }

  line(s) {
    const l = `${this.t()}  ${s}`;
    console.log(l);
    appendFileSync(this.file, l + '\n');
  }

  waitFor(pred, timeout) {
    return new Promise((res) => {
      const l = (e) => {
        if (!pred(e)) return;
        this.listeners.delete(l);
        clearTimeout(timer);
        res(e);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        res(null);
      }, timeout);
      this.listeners.add(l);
    });
  }

  emit = (e) => {
    try {
      this.onEvent(e);
    } catch (err) {
      console.error('recorder error', err);
    }
    for (const l of [...this.listeners]) l(e);
  };

  onEvent(e) {
    const cur = this.cur;
    switch (e.type) {
      case 'project/opened':
        this.hook();
        for (const n of Object.values(e.snapshot.map.nodes)) this.mapNodes.set(n.id, n);
        this.line(`· project opened: ${e.snapshot.project.name} (new=${e.snapshot.project.isNew}, ${Object.keys(e.snapshot.map.nodes).length} nodes, ${e.snapshot.files.length} files, ${e.snapshot.agenda.length} open questions, ${e.snapshot.decisions.length} decisions)`);
        for (const a of e.snapshot.agenda) this.agenda.set(a.id, a);
        break;
      case 'lead/delta':
        if (cur && !cur.firstDeltaAt) cur.firstDeltaAt = Date.now();
        break;
      case 'lead/done':
        if (cur) {
          cur.doneAt = Date.now();
          cur.text = e.text;
          this.closeTurn(cur);
        }
        break;
      case 'map/ops': {
        for (const o of e.ops) {
          if (o.op === 'upsertNode') this.mapNodes.set(o.node.id, { ...(this.mapNodes.get(o.node.id) ?? {}), ...o.node });
          if (o.op === 'removeNode') this.mapNodes.delete(o.id);
        }
        if (cur && e.source === 'lead') cur.mapOps.push(...e.ops);
        else if (e.source !== 'lead') this.line(`  map(${e.source}): ${summarizeOps(e.ops)}`);
        break;
      }
      case 'agenda/upsert': {
        const prev = this.agenda.get(e.item.id);
        this.agenda.set(e.item.id, e.item);
        if (!prev) {
          if (cur) cur.asked.push(e.item);
          else this.line(`  ? card [${e.item.id}]${e.item.blocking?.length ? ' BLOCKING ' + e.item.blocking.join(',') : ''} on ${e.item.nodeId ?? '-'}: "${e.item.prompt}" (${(e.item.options ?? []).join(' | ')})`);
        }
        break;
      }
      case 'agenda/remove': {
        const it = this.agenda.get(e.id);
        if (cur) cur.closed.push(e.id);
        else this.line(`  ✓ card closed [${e.id}] "${it?.prompt?.slice(0, 60) ?? ''}"`);
        break;
      }
      case 'decision/add': {
        const d = `${e.decision.title}${e.decision.rationale ? ` (${e.decision.rationale})` : ''}`;
        if (cur) cur.decisions.push(d);
        else this.line(`  ◆ decision: ${d}`);
        break;
      }
      case 'focus':
        if (cur) cur.focus.push(`${e.nodeId ?? 'top'}:${e.mode}`);
        break;
      case 'agent/upsert': {
        const a = e.agent;
        const key = `${a.id}:${a.status}`;
        this.agentSeen ??= new Set();
        if (this.agentSeen.has(key)) break;
        this.agentSeen.add(key);
        if (['starting', 'done', 'failed', 'stopped', 'waiting'].includes(a.status))
          this.line(`  ⚙ ${a.name} [${a.role}] ${a.status}${a.nodeId ? ` @${a.nodeId}` : ''}${a.result ? ` → ${a.result.slice(0, 220)}` : ''}`);
        break;
      }
      case 'permission/request':
        this.line(`  🔒 permission asked (${e.tool}): ${e.summary} → auto-allowed by harness`);
        setTimeout(() => void this.engine?.resolvePermission(e.id, 'allow'), 30);
        break;
      case 'ghost/proposals':
        this.lastGhosts = e;
        break;
      case 'notice':
        this.line(`  ! notice ${e.level}: ${e.text}`);
        break;
      default:
        break;
    }
  }

  /** Instruments the lead and crew of the session that just opened (runs before session.start()). */
  hook() {
    const p = this.engine.project;
    const lead = p.lead;
    const self = this;
    const origStart = lead.startTurn.bind(lead);
    lead.startTurn = (session, pending) => {
      if (!session.__hooked) {
        session.__hooked = true;
        const push = session.input.push.bind(session.input);
        session.input.push = (text) => {
          if (self.cur) self.cur.prompt = text;
          push(text);
        };
      }
      const turn = {
        n: self.turns.length + 1,
        kind: pending.kind,
        body: pending.body,
        startAt: Date.now(),
        sayAt: pending.kind === 'user' ? self.lastSayAt : 0,
        firstDeltaAt: 0,
        doneAt: 0,
        text: '',
        blocks: [],
        mapOps: [],
        asked: [],
        closed: [],
        decisions: [],
        focus: [],
        usage: null,
        prompt: '',
        cards: p.ws.agenda.open().filter((i) => !i.blocking?.length).map((i) => ({ id: i.id, prompt: i.prompt, createdAt: i.createdAt })),
      };
      self.cur = turn;
      self.turns.push(turn);
      origStart(session, pending);
    };
    const origMsg = lead.onMessage.bind(lead);
    lead.onMessage = (session, m) => {
      const cur = self.cur;
      if (cur && m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message.content) {
          if (b.type === 'thinking') cur.thinking = (cur.thinking ?? 0) + (b.thinking?.length ?? 0);
          else if (b.type === 'text' && b.text?.trim()) cur.blocks.push({ type: 'text', text: b.text.trim() });
          else if (b.type === 'tool_use') cur.blocks.push({ type: 'tool', name: b.name.replace('mcp__iae__', ''), input: b.input });
        }
      }
      if (cur && m.type === 'result') cur.usage = { ...(m.usage ?? {}), cost: m.total_cost_usd, ms: m.duration_ms, apiMs: m.duration_api_ms };
      return origMsg(session, m);
    };
    const crew = p.crew;
    const origSpawn = crew.spawn.bind(crew);
    crew.spawn = (job) => {
      const agent = origSpawn(job);
      self.briefs.push({ at: Date.now(), name: agent.name, id: agent.id, ...job });
      const run = crew.runs.get(agent.id);
      if (run) self.hookRun(run);
      return agent;
    };
  }

  hookRun(run) {
    const self = this;
    const orig = run.onMessage.bind(run);
    run.onMessage = (m) => {
      if (m.type === 'assistant') {
        for (const b of m.message.content) {
          if (b.type === 'tool_use' && /ask_architect|map_update/.test(b.name)) {
            const name = b.name.replace('mcp__iae__', '');
            if (name === 'ask_architect') self.builderAsks.push({ at: Date.now(), agent: run.agent.name, input: b.input });
            self.line(`  ⚙ ${run.agent.name} → ${name} ${JSON.stringify(b.input).slice(0, 260)}`);
          }
        }
      }
      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type !== 'tool_result') continue;
          const txt = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? '');
          if (/architect answered|No answer|Asked \[/.test(txt)) self.line(`  ⚙ ${run.agent.name} ← ${txt.slice(0, 200)}`);
        }
      }
      if (m.type === 'user' && typeof m.message?.content === 'string' && /Message from the architect/.test(m.message.content)) {
        self.line(`  ⚙ ${run.agent.name} ← ${m.message.content.slice(0, 200)}`);
      }
      return orig(m);
    };
    const origMessage = run.message.bind(run);
    run.message = (text) => {
      self.line(`  ⚙ → ${run.agent.name} (message): ${text.slice(0, 200)}`);
      return origMessage(text);
    };
  }

  closeTurn(turn) {
    this.cur = null;
    const ttft = turn.firstDeltaAt ? turn.firstDeltaAt - (turn.sayAt || turn.startAt) : null;
    const total = turn.doneAt - (turn.sayAt || turn.startAt);
    turn.ttft = ttft;
    turn.total = total;
    const head = turn.kind === 'user' ? 'USER TURN' : turn.kind === 'pulse' ? 'PULSE' : 'EVENTS';
    const ctx = turn.prompt ? ` ctx=${turn.prompt.length}ch` : '';
    const u = turn.usage;
    const tok = u ? ` in=${(u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)}tok out=${u.output_tokens ?? 0}` : '';
    this.line(`  [${head} #${turn.n}] ttft=${ttft ?? '—'}ms total=${total}ms${ctx}${tok}`);
    if (turn.kind !== 'user') {
      const evs = (turn.prompt.match(/<events>([\s\S]*?)<\/events>/) ?? [])[1];
      if (evs) this.line(`    events in: ${evs.trim().replace(/\n/g, ' ‖ ').slice(0, 400)}`);
    }
    this.line(`  ARCHIE: ${turn.text ? `"${turn.text}"` : '(silence)'}  [${words(turn.text)}w]`);
    const seq = turn.blocks.map((b) => (b.type === 'text' ? 'text' : b.name)).join(' → ');
    if (seq) this.line(`    sequence: ${seq}`);
    for (const b of turn.blocks) {
      if (b.type !== 'tool') continue;
      if (b.name === 'sketch_map') continue;
      if (b.name === 'delegate') this.line(`    delegate ${b.input.kind ?? 'build'} "${b.input.title}" on ${b.input.node_id ?? '-'}:\n      ${String(b.input.brief).replace(/\n/g, '\n      ')}`);
      else if (b.name === 'ask') this.line(`    ask on ${b.input.node_id ?? '-'} (${b.input.kind ?? 'decision'}, p=${b.input.priority ?? '-'}): "${b.input.prompt}" [${(b.input.options ?? []).join(' | ')}]`);
      else this.line(`    ${b.name} ${JSON.stringify(b.input).slice(0, 200)}`);
    }
    if (turn.mapOps.length) this.line(`    map: ${summarizeOps(turn.mapOps)}`);
    if (turn.decisions.length) this.line(`    decisions: ${turn.decisions.join(' · ')}`);
    if (turn.closed.length) this.line(`    closed: ${turn.closed.join(', ')}`);
    this.checkRepeats(turn);
    const waiters = this.pendingTurnWaiters ?? [];
    this.pendingTurnWaiters = [];
    for (const w of waiters) w(turn);
  }

  /**
   * Did this turn ask an open card's question again (a card raised in an
   * earlier turn)? Looser than the engine's guard (which trims only near-verbatim
   * repeats): this measures the habit. "raw" is what the model wrote, "spoken"
   * what was said after the guard.
   */
  checkRepeats(turn) {
    this.spoken ??= [];
    const raw = turn.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const qs = (t) => (t || '').split(/(?<=[.!?])\s+/).filter((x) => x.trim().endsWith('?'));
    const hit = (q) =>
      turn.cards.find(
        (c) => sim(q, c.prompt) >= 0.5 || this.spoken.some((p) => p.at >= c.createdAt && sim(p.text, c.prompt) >= 0.3 && sim(q, p.text) >= 0.6),
      );
    const asksOpen = /what'?s (next|left)|left to decide|remind me|what was the question/i.test(turn.body);
    if (turn.kind !== 'pulse' && !asksOpen) {
      for (const [where, text] of [['raw', raw], ['spoken', turn.text]]) {
        const q = qs(text).find(hit);
        if (q) {
          turn.repeats = { ...(turn.repeats ?? {}), [where]: q };
          this.line(`    ↺ ${where} repeats card [${hit(q).id}]: "${q}"`);
        }
      }
    }
    for (const q of qs(turn.text)) this.spoken.push({ text: q, at: Date.now() });
  }

  /** The next lead turn that finishes (any kind). */
  nextTurn(timeout = 120_000) {
    return new Promise((res) => {
      const timer = setTimeout(() => res(null), timeout);
      (this.pendingTurnWaiters ??= []).push((t) => {
        clearTimeout(timer);
        res(t);
      });
    });
  }

  async say(text, meta, skip = 0) {
    this.line(`USER: "${text}"`);
    this.lastSayAt = Date.now();
    const done = this.waitUserTurnDone(180_000, skip);
    await this.engine.say(text, meta ?? { via: 'voice' });
    return done;
  }

  async answer(id, answer) {
    const it = this.agenda.get(id);
    this.line(`USER taps card [${id}] "${it?.prompt ?? ''}" → "${answer}"`);
    this.lastSayAt = Date.now();
    const done = this.waitUserTurnDone();
    await this.engine.answer(id, answer);
    return done;
  }

  /** Resolves when a user-kind turn finishes (skipping events/pulse turns that were in flight). */
  waitUserTurnDone(timeout = 180_000, skip = 0) {
    return new Promise((res) => {
      const timer = setTimeout(() => res(null), timeout);
      const check = (t) => {
        if (t.kind === 'user' && skip-- <= 0) {
          clearTimeout(timer);
          res(t);
        } else (this.pendingTurnWaiters ??= []).push(check);
      };
      (this.pendingTurnWaiters ??= []).push(check);
    });
  }

  /** Waits quietly, logging every unprompted turn, for `ms`. */
  async quiet(ms, label = '') {
    this.line(`── quiet ${Math.round(ms / 1000)}s ${label}`);
    await sleep(ms);
  }

  openAgenda() {
    return [...this.agenda.values()].filter((a) => !a.status || a.status === 'open').filter((a) => this.engine.project?.ws.agenda.get(a.id)?.status === 'open');
  }

  topCard() {
    return this.engine.project?.ws.agenda.open()[0] ?? null;
  }

  finish() {
    const report = scorecard(this);
    appendFileSync(this.file, '\n' + report + '\n');
    console.log('\n' + report);
    writeFileSync(join(this.dir, 'turns.json'), JSON.stringify(this.turns, null, 2));
    writeFileSync(join(this.dir, 'briefs.json'), JSON.stringify(this.briefs, null, 2));
    if (this.engine?.project) writeFileSync(join(this.dir, 'map.json'), JSON.stringify(this.engine.project.ws.map, null, 2));
    return report;
  }
}

const STOP = new Set(
  `a an the to of for in on at by with and or but if so then than as is are was were be been being do does did done it its this that these those there here we you they i i'd i'll i'm me my your their them our should would could can will may might must need needs want wants go going keep use just still now also too have has had get got make made one first which what how when where who why sound sounds right ok okay yes no sure call your quick question decide choose either`.split(/\s+/),
);
function words2(t) {
  const out = new Set();
  for (const w of String(t).toLowerCase().split(/[^a-z0-9']+/)) {
    const x = w.replace(/^'+|'+$/g, '');
    if (x && !STOP.has(x)) out.add(x.length > 3 ? x.replace(/(?<!s)s$/, '') : x);
  }
  return out;
}
function sim(a, b) {
  const x = words2(a);
  const y = words2(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return (2 * n) / (x.size + y.size);
}

function summarizeOps(ops) {
  const nodes = ops.filter((o) => o.op === 'upsertNode').map((o) => `${o.node.parentId ? o.node.parentId + '/' : ''}${o.node.id}${o.node.label ? `("${o.node.label}")` : ''}${o.node.status ? `:${o.node.status}` : ''}${o.node.paths?.length ? `{${o.node.paths.join(',')}}` : ''}`);
  const edges = ops.filter((o) => o.op === 'upsertEdge').map((o) => `${o.edge.from}→${o.edge.to}`);
  const rm = ops.filter((o) => o.op === 'removeNode').map((o) => `-${o.id}`);
  const mv = ops.filter((o) => o.op === 'moveNode').map((o) => `${o.id}⇒${o.parentId}`);
  return [...nodes, ...rm, ...mv, edges.length ? `edges: ${edges.join(', ')}` : ''].filter(Boolean).join('  ');
}

// ── mechanical scorecard (docs/CONVERSATION.md) ─────────────────────────────

const FILLER = /\b(great question|certainly|absolutely|of course|let me know|happy to|sounds good|got it|perfect|awesome|as an ai|good call|nice one|love (it|that)|great idea|great[,!.])/i;
const GENERIC = /(what would you like|anything else|any preferences|how would you like|what do you think\?|what else|where should we start|what should we (do|build) next|do you want me to)/i;
const RECOMMEND = /\b(I'd|I would|I'll|I will|I'm going|I recommend|I suggest|recommend|default|my pick|I lean|let's|keep|start with|go with|unless|sound right|okay\?|ok\?|fine\?|right\?)\b/i;

function scorecard(run) {
  const said = run.turns.filter((t) => t.text);
  const lines = [`SCORECARD — ${run.name}`];
  const user = run.turns.filter((t) => t.kind === 'user');
  const ttfts = user.map((t) => t.ttft).filter((x) => x != null).sort((a, b) => a - b);
  const totals = user.map((t) => t.total).sort((a, b) => a - b);
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : '—');
  const p90 = (a) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : '—');
  lines.push(`latency (user turns): TTFT median ${med(ttfts)}ms p90 ${p90(ttfts)}ms max ${ttfts.at(-1) ?? '—'} · turn median ${med(totals)}ms max ${totals.at(-1) ?? '—'}`);
  const ctx = run.turns.map((t) => t.prompt.length).filter(Boolean);
  lines.push(`context per turn: median ${med([...ctx].sort((a, b) => a - b))} chars, max ${Math.max(0, ...ctx)}`);
  const cost = run.turns.reduce((s, t) => s + (t.usage?.cost ?? 0), 0);
  lines.push(`lead cost: $${cost.toFixed(3)} over ${run.turns.length} turns`);
  let issues = 0;
  const flag = (t, what) => {
    issues++;
    lines.push(`  ✗ #${t.n} ${what}`);
  };
  for (const t of said) {
    const w = words(t.text);
    if (w > 40) flag(t, `${w} words (>~35)`);
    const q = (t.text.match(/\?/g) ?? []).length;
    if (q > 1) flag(t, `${q} questions`);
    if (FILLER.test(t.text)) flag(t, `filler: "${t.text.match(FILLER)[0]}"`);
    if (GENERIC.test(t.text)) flag(t, `generic: "${t.text.match(GENERIC)[0]}"`);
    if (q === 1 && !RECOMMEND.test(t.text)) flag(t, 'question without a recommended default');
    if (/[*#`]|^\s*-\s/m.test(t.text)) flag(t, 'markdown in speech');
    const first = t.blocks[0];
    if (first && first.type !== 'text') flag(t, `tool before speech (${first.name})`);
  }
  for (const t of run.turns) {
    for (const b of t.blocks.filter((b) => b.type === 'tool' && b.name === 'ask')) {
      const i = b.input;
      if (words(i.prompt) > 25) flag(t, `card prompt ${words(i.prompt)} words`);
      if (!i.options || i.options.length < 2) flag(t, `card without 2–4 options: "${i.prompt}"`);
      if (!i.node_id) flag(t, `card not anchored: "${i.prompt}"`);
      if (GENERIC.test(i.prompt)) flag(t, `generic card: "${i.prompt}"`);
    }
    for (const b of t.blocks.filter((b) => b.type === 'tool' && b.name === 'delegate')) {
      const br = String(b.input.brief ?? '');
      if (br.length < 200) flag(t, `thin brief (${br.length} chars): "${b.input.title}"`);
      if (!/\/|\.\w{2,4}\b/.test(br)) flag(t, `brief names no paths: "${b.input.title}"`);
      if (!/done|verify|test|typecheck|should return|returns|passes|confirm/i.test(br)) flag(t, `brief lacks a definition of done: "${b.input.title}"`);
      if (!b.input.node_id) flag(t, `delegate without node: "${b.input.title}"`);
    }
  }
  const pulses = run.turns.filter((t) => t.kind === 'pulse');
  const evs = run.turns.filter((t) => t.kind === 'events');
  const rep = run.turns.filter((t) => t.repeats);
  lines.push(`card repeats (open card asked again in a later turn): written ${rep.filter((t) => t.repeats.raw).length}, spoken ${rep.filter((t) => t.repeats.spoken).length}`);
  issues += rep.filter((t) => t.repeats.spoken).length;
  lines.push(`unprompted: ${pulses.length} pulses (${pulses.filter((t) => !t.text).length} silent), ${evs.length} event turns (${evs.filter((t) => !t.text).length} silent)`);
  if (pulses.length > 1) {
    const gaps = pulses.slice(1).map((t, i) => Math.round((t.startAt - pulses[i].startAt) / 1000));
    lines.push(`pulse gaps: ${gaps.join('s, ')}s`);
  }
  // Map legibility
  const nodes = [...run.mapNodes.values()];
  const longLabels = nodes.filter((n) => n.label && words(n.label) > 3);
  for (const n of longLabels) {
    issues++;
    lines.push(`  ✗ label >3 words: "${n.label}"`);
  }
  const top = nodes.filter((n) => !n.parentId);
  lines.push(`map: ${nodes.length} nodes, ${top.length} top-level${top.length > 7 ? ' (✗ >7)' : ''}, ${nodes.filter((n) => n.parentId).length} nested, ${nodes.filter((n) => n.paths?.length).length} with paths`);
  if (top.length > 7) issues++;
  lines.push(`spoken turns ${said.length}/${run.turns.length}; mechanical issues: ${issues}`);
  return lines.join('\n');
}

// ── engine per scenario ─────────────────────────────────────────────────────

async function withEngine(name, fn) {
  const run = new Run(name);
  const sandbox = join(run.dir, 'home');
  mkdirSync(sandbox, { recursive: true });
  const engine = new Engine(run.emit, {
    pickFolder: async () => null,
    userDataDir: () => join(sandbox, 'userData'),
    homeDir: () => sandbox,
    revealFile: () => {},
  });
  run.engine = engine;
  await engine.boot();
  const home = await engine.getHome();
  if (home.claude !== 'ready') throw new Error(`Claude unavailable: ${home.claudeDetail}`);
  try {
    await fn(run, engine, sandbox);
  } catch (e) {
    run.line(`!! scenario error: ${e?.stack ?? e}`);
  }
  run.finish();
  await engine.closeProject().catch(() => {});
  await engine.shutdown().catch(() => {});
  return run;
}

/** Waits for the greeting (the first lead/done after open). */
const greeting = (run) => run.nextTurn(60_000);

// ── scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = {
  /** a. New project ideation: vague → sharper, cards answered/ignored, a change of mind. */
  async climbing(run, engine, sandbox) {
    const snap = await engine.createProject('Crux', sandbox);
    run.projectRoot = snap.project.root;
    writeFileSync(join(run.dir, 'project-root.txt'), snap.project.root);
    await greeting(run);
    await run.say('So I run a climbing gym and I want an app for it.');
    await run.say('Mostly for members. They should see which routes are up on the walls right now, and our setters post new routes every week.');
    let top = run.topCard();
    if (top) await run.answer(top.id, top.options?.[0] ?? 'yes');
    else await run.say('Members log in with their gym membership number.');
    await run.say("Members also want to book belay classes and pay for them, and buy day passes.");
    // Ignore whatever card is up; talk about something else.
    await run.say('Oh and they should get a notification when new routes in their grade go up.');
    top = run.topCard();
    if (top && top.options?.length > 1) await run.answer(top.id, top.options[1]);
    await run.say("Actually, scrap class booking. We already use Mindbody for classes and that's staying. Payments are just for day passes.");
    await run.say("What's the riskiest part of this so far?");
    await run.say("Ok. Let's get the route board started.");
    // Capture the delegation; stop the builder quickly to keep cost down.
    await sleep(8000);
    for (const b of run.briefs) await engine.stopAgent(b.id).catch(() => {});
    await run.quiet(30_000, '(pulse window)');
    await sleep(5000);
  },

  /** b. Existing repo: Stripe keys + premium recipes. */
  async stripe(run, engine, sandbox) {
    const copy = join(sandbox, 'recipe-box');
    cpSync(join(repo, 'examples/recipe-box'), copy, { recursive: true, filter: (src) => !/node_modules|\.iae$/.test(src) });
    run.projectRoot = copy;
    writeFileSync(join(run.dir, 'project-root.txt'), copy);
    const atlasDone = run.waitFor((e) => e.type === 'agent/upsert' && e.agent.id === 'atlas' && ['done', 'failed'].includes(e.agent.status), 420_000);
    await engine.openProject(copy);
    await greeting(run);
    run.line('── waiting for Atlas');
    await atlasDone;
    // Let the "Atlas finished" events turn happen.
    await run.nextTurn(30_000);
    await sleep(1500);
    await run.say('I need to add Stripe keys and charge for premium recipes.');
    let top = run.topCard();
    await run.say("Premium is a monthly subscription, 4 dollars, unlocks all recipes authors mark as premium.");
    top = run.topCard();
    if (top) await run.answer(top.id, top.options?.[0] ?? 'yes');
    await sleep(15_000);
    for (const b of run.briefs) await engine.stopAgent(b.id).catch(() => {});
    await sleep(3000);
  },

  /** c. Never idle: a real small build, silence, pulse, report, then builder questions. */
  async idle(run, engine, sandbox) {
    const src = opt('--project');
    const copy = src ? resolve(src) : join(sandbox, 'recipe-box');
    if (!src) {
      cpSync(join(repo, 'examples/recipe-box'), copy, { recursive: true, filter: (s) => !/node_modules|\.iae$/.test(s) });
      run.line('(fresh recipe-box copy; Atlas will map it)');
    }
    run.projectRoot = copy;
    const atlasDone = run.waitFor((e) => e.type === 'agent/upsert' && e.agent.id === 'atlas' && ['done', 'failed'].includes(e.agent.status), 420_000);
    await engine.openProject(copy);
    await greeting(run);
    if (!src) {
      await atlasDone;
      await run.nextTurn(30_000);
    }
    await sleep(1500);
    const finished = run.waitFor((e) => e.type === 'agent/upsert' && e.agent.role === 'builder' && ['done', 'failed'].includes(e.agent.status), 600_000);
    await run.say('Add a /health route to the API that returns ok.');
    run.line('── silent while the builder works');
    const f = await finished;
    run.line(`── builder ${f?.agent.status ?? 'timeout'}`);
    await run.quiet(Number(opt('--quiet', '240')) * 1000, 'after the build (report, then backoff)');

    // Builder questions: one blocking, one not.
    run.line('── builder questions');
    const blockingCard = run.waitFor((e) => e.type === 'agenda/upsert' && e.item.blocking?.length, 400_000);
    const finished2 = run.waitFor((e) => e.type === 'agent/upsert' && e.agent.role === 'builder' && ['done', 'failed'].includes(e.agent.status) && e.agent.task.toLowerCase().includes('version'), 900_000);
    await run.say(
      "Have a builder add a /version route to the API. Before writing it they must ask me, as a blocking question, whether it should include the git commit sha. They should also ask me, without waiting, whether to document it in the README.",
    );
    const card = await blockingCard;
    if (card) {
      const tCard = Date.now();
      run.line(`── blocking card appeared: "${card.item.prompt}"`);
      const mention = await run.nextTurn(60_000);
      run.line(`── lead surfaced it after ${mention ? mention.doneAt - tCard : '∞'}ms: ${mention?.text ? `"${mention.text}"` : '(silence)'}`);
      await sleep(4000);
      await run.say('Yes, include the short sha.', { via: 'voice', agendaId: card.item.id });
    } else run.line('── no blocking card within the window');
    await sleep(20_000);
    const nb = [...run.agenda.values()].find((a) => !a.blocking?.length && /readme/i.test(a.prompt) && engine.project.ws.agenda.get(a.id)?.status === 'open');
    if (nb) await run.answer(nb.id, nb.options?.[0] ?? 'Yes');
    else run.line('── no open README question');
    const f2 = await finished2;
    run.line(`── /version builder ${f2?.agent.status ?? 'timeout'}`);
    await run.nextTurn(60_000);
    await sleep(3000);
  },

  /** d. Barge-in: interrupt mid-reply, then a quick follow-up. */
  async bargein(run, engine, sandbox) {
    const snap = await engine.createProject('Trailhead', sandbox);
    run.projectRoot = snap.project.root;
    await greeting(run);
    await run.say('An app where my friends and I plan hiking trips together.');
    for (let i = 0; i < 2; i++) {
      run.line('── long question, interrupt after the first words');
      const fd = run.waitFor((e) => e.type === 'lead/delta', 20_000);
      run.lastSayAt = Date.now();
      run.line(`USER: "Walk me through every piece of this and how each one talks to the others, in detail."`);
      const cutTurn = run.nextTurn(30_000);
      await engine.say('Walk me through every piece of this and how each one talks to the others, in detail.', { via: 'voice' });
      await fd;
      await sleep(i === 0 ? 300 : 1200);
      const tInt = Date.now();
      await engine.interrupt();
      const ct = await cutTurn;
      run.line(`── interrupt → turn ended in ${ct ? Date.now() - tInt : '∞'}ms (said "${ct?.text ?? ''}")`);
      await run.say(i === 0 ? 'Never mind. Where do the trip dates live?' : 'Skip that. Do we need accounts at all?');
    }
    // Barge in after the opening was said, while the lead is still calling tools:
    // what it promised must still happen, and the follow-up must come right after.
    run.line('── barge-in during the tool tail');
    const fd = run.waitFor((e) => e.type === 'lead/delta', 20_000);
    const delegated = run.waitFor((e) => e.type === 'agent/upsert' && e.agent.role === 'builder' && e.agent.status === 'starting', 60_000);
    const tail = run.nextTurn(90_000);
    run.lastSayAt = Date.now();
    run.line('USER: "Go ahead and have a builder start on the trips API now."');
    await engine.say('Go ahead and have a builder start on the trips API now.', { via: 'voice' });
    await fd;
    await sleep(2500);
    const tInt = Date.now();
    await engine.interrupt();
    run.line('── barge-in (interrupt) 2.5s after the first words');
    // Queued behind the tail: the second user turn to finish is the follow-up.
    const follow = run.say('Trips also need a cover photo.', undefined, 1);
    const tt = await tail;
    const d = await delegated;
    run.line(`── tool tail finished ${tt ? tt.doneAt - tInt : '∞'}ms after the barge-in; delegation ${d ? `happened (${d.agent.name})` : 'LOST'}`);
    const f = await follow;
    run.line(`── follow-up first words ${f?.firstDeltaAt ? f.firstDeltaAt - tInt : '∞'}ms after the barge-in (${f?.firstDeltaAt && tt ? f.firstDeltaAt - tt.doneAt : '∞'}ms after the tail ended)`);
    for (const b of run.briefs) await engine.stopAgent(b.id).catch(() => {});
    await sleep(2000);
  },

  /** e. Continuity: close and reopen a project; memory should survive. */
  async resume(run, engine) {
    const root = opt('--project');
    if (!root || !existsSync(root)) throw new Error('resume needs --project <dir of a previous climbing run>');
    run.projectRoot = root;
    const state = JSON.parse(readFileSync(join(root, '.iae/state.json'), 'utf8'));
    run.line(`· stored lead session: ${state.leadSessionId}`);
    const decisions = JSON.parse(readFileSync(join(root, '.iae/decisions.json'), 'utf8'));
    run.line(`· decisions on disk: ${decisions.map((d) => d.title).join(' · ')}`);
    await engine.openProject(root);
    await greeting(run);
    await run.say('Where were we?');
    await run.say('Remind me, how are people paying for day passes?');
    await run.say("Let's think about the notifications piece next.");
    await sleep(3000);
  },

  /** Renaming the lead mid-session: it should use the new name from the next turn. */
  async rename(run, engine, sandbox) {
    const snap = await engine.createProject('Namesake', sandbox);
    run.projectRoot = snap.project.root;
    await greeting(run);
    await run.say('A tiny app for tracking which houseplants need water.');
    run.line('── settings: lead name → Juniper');
    await engine.setSettings({ leadName: 'Juniper' });
    await run.say("Sorry, what's your name again?");
    await engine.setSettings({ leadName: 'Archie' });
  },

  /**
   * Honest recall: talk past the open card several times (does Archie keep
   * asking it?), let Archie make a technical call of its own, answer a card,
   * then reopen the project and ask who decided what.
   */
  async recall(run, engine, sandbox) {
    const snap = await engine.createProject('Crag Night', sandbox);
    const root = snap.project.root;
    run.projectRoot = root;
    writeFileSync(join(run.dir, 'project-root.txt'), root);
    await greeting(run);
    await run.say('Crag Night is our climbing gym. Members check in at the front desk and see which routes are up on the walls.');
    // Requests that neither answer the card nor invite a new one.
    await run.say('Show me where the routes live.');
    await run.say('What does the route board do, in one line?');
    await run.say('Setters reset one wall every Tuesday, usually about twelve new routes.');
    const started = run.waitFor((e) => e.type === 'agent/upsert' && e.agent.role === 'builder' && e.agent.status === 'starting', 60_000);
    await run.say("Let's get the route board started.");
    if (await started) {
      await sleep(6000);
      for (const b of run.briefs) await engine.stopAgent(b.id).catch(() => {});
      await sleep(500);
      for (const it of engine.project.ws.agenda.open())
        run.line(`── after stop, card [${it.id}] blocking=[${(it.blocking ?? []).join(',')}] why=${JSON.stringify(it.why ?? null)}`);
    }
    await run.say("Members use it on their phones in the gym where the wifi is patchy. How logged sends get stored and synced is your call, I don't mind.");
    const top = run.topCard();
    if (top) await run.answer(top.id, top.options?.[0] ?? 'yes');
    const ds = engine.project.ws.agenda.allDecisions();
    run.line(`── decisions on disk: ${ds.map((d) => `${d.title}${d.rationale ? ` (${d.rationale})` : ''}`).join(' · ') || '(none)'}`);
    run.line('── close and reopen');
    await engine.closeProject();
    await engine.openProject(root);
    await greeting(run);
    await run.say('Remind me what has been decided so far, and who decided each thing.');
    await sleep(2000);
  },

  /** Sketcher: latency and quality on typical partial sentences. */
  async sketch(run, engine, sandbox) {
    const copy = join(sandbox, 'recipe-box');
    cpSync(join(repo, 'examples/recipe-box'), copy, { recursive: true, filter: (s) => !/node_modules|\.iae$/.test(s) });
    // Use the heuristic map only (no Atlas): pretend it was already cartographed.
    mkdirSync(join(copy, '.iae'), { recursive: true });
    const mapSrc = opt('--map');
    if (mapSrc) writeFileSync(join(copy, '.iae/map.json'), readFileSync(mapSrc));
    writeFileSync(join(copy, '.iae/state.json'), JSON.stringify({ createdAt: Date.now(), cartographedAt: Date.now(), isNew: false }));
    if (argv.includes('--grow-only')) return sketchGrow(run, engine, sandbox);
    await engine.openProject(copy);
    await greeting(run);
    const nodes = Object.values(engine.project.ws.map.nodes).map((n) => `${n.id}(${n.label})`);
    run.line(`map: ${nodes.join(', ')}`);
    const drafts = [
      'I want to add a meal planner where',
      'users can save recipes into collections and share them with',
      'when someone uploads a photo we should resize it and',
      'add Stripe so people can pay for premium',
      'the recipes API needs rate limiting and',
      'send a push notification to their phone when',
      'we need an admin dashboard for moderating',
      'search should also find recipes by ingredient',
      'let people sign in with Apple as well as Google',
      'a weekly email digest of',
    ];
    const stats = [];
    for (const [i, d] of drafts.entries()) {
      const id = `s${i}`;
      const got = run.waitFor((e) => e.type === 'ghost/proposals' && e.draftId === id, 20_000);
      const t = Date.now();
      await engine.draft(id, d);
      const g = await got;
      const ms = g ? Date.now() - t : null;
      stats.push(ms);
      run.line(`DRAFT "${d}" → ${ms ?? '∞'}ms: ${g ? g.proposals.map((p) => `${p.label}(${p.kind}${p.nearNodeId ? '→' + p.nearNodeId : ''} ${p.confidence})`).join(', ') || '[]' : 'timeout'}`);
      await sleep(400);
    }
    const ok = stats.filter((x) => x != null).sort((a, b) => a - b);
    run.line(`sketcher latency (incl. 300ms debounce): median ${ok[Math.floor(ok.length / 2)]}ms, max ${ok.at(-1)}ms, ${stats.length - ok.length} timeouts`);
    if (!argv.includes('--no-grow')) await sketchGrow(run, engine, sandbox);
  },
};

/**
 * One utterance that grows the way speech-to-text interims do (same draft id,
 * a longer text about every second). Ghosts must accumulate: what the first
 * words implied is still on the map when the person presses Enter. Ghost state
 * follows the renderer: each sketch event replaces the previous sketch ghosts.
 */
async function sketchGrow(run, engine, sandbox) {
  await engine.createProject('Crag Night', sandbox);
  await greeting(run);
  const words = [
    'Crag Night is an app for our climbing gym where members can book classes',
    'and sign in with their member account,',
    "track the routes they've climbed,",
    'check in at the front desk by scanning a QR code at the door,',
    'and we check their membership is still valid before letting them in.',
  ];
  const id = 'grow-1';
  const events = [];
  let ghosts = {};
  const l = (e) => {
    if (e.type !== 'ghost/proposals' || e.draftId !== id) return false;
    ghosts = Object.fromEntries(e.proposals.map((p) => [p.key, p]));
    events.push({ at: Date.now(), keys: e.proposals.map((p) => p.key) });
    run.line(`  ghosts ← ${e.proposals.map((p) => `${p.label}[${p.key}]`).join(', ') || '[]'}`);
    return false;
  };
  run.listeners.add(l);
  let text = '';
  const t0 = Date.now();
  for (const w of words) {
    text = text ? `${text} ${w}` : w;
    run.line(`DRAFT+ "${text}"`);
    await engine.draft(id, text);
    await sleep(1200);
  }
  const tLast = Date.now();
  await sleep(4000);
  run.listeners.delete(l);
  const final = Object.values(ghosts);
  const seen = new Set(events.flatMap((e) => e.keys));
  const dropped = [...seen].filter((k) => !ghosts[k]);
  run.line(`grow: ${events.length} proposal events over ${Math.round((tLast - t0) / 1000)}s; at Enter ${final.length} ghosts: ${final.map((p) => p.label).join(', ')}`);
  run.line(`grow: keys ever shown ${seen.size}, dropped before Enter: ${dropped.length ? dropped.join(', ') : 'none'}`);
}

// ── main ────────────────────────────────────────────────────────────────────

const list = scenarios.length ? scenarios : ['climbing'];
console.log(`transcripts → ${outRoot}`);
for (const name of list) {
  const fn = SCENARIOS[name];
  if (!fn) {
    console.error(`unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
    continue;
  }
  await withEngine(name, fn);
}
console.log(`\ndone → ${outRoot}`);
process.exit(0);
