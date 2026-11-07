// Atlas, the cartographer: on the first open of an existing repo, a read-only
// session explores the code and redraws the heuristic map into a real
// hierarchy, progressively, while the lead greets the person.

import { query, type Query } from './agent';
import type { EngineEvent } from '../../shared/events';
import { describeMap, ownerOf } from '../../shared/map';
import type { AgentInfo, Settings } from '../../shared/model';
import { describeToolUse } from './activity';
import { plainActivity } from './plain';
import { createCrewTools, crewToolNames } from './crew-tools';
import { OP_NAMES } from './mapops';
import { cartographerPrompt } from './prompts';
import { errorText, InputQueue, leanOptions, log } from './sdk';
import type { Workspace } from './workspace';

export const ATLAS_ID = 'atlas';
const REMOVE_AFTER_MS = 6_000;
const TOOLS = ['Read', 'Glob', 'Grep'];

const SYSTEM = `You are Atlas, Arxitect's cartographer: a fast, read-only code explorer that draws architecture maps. Work efficiently: make independent tool calls in parallel, use Glob and Grep to find things, and Read only what matters (manifests, entry points, routers, schemas, config). Never modify files. Your final message is one plain sentence describing the system.`;

/** A compact picture of the tree: directories with file counts, then a sample of files, shallow first. */
export function fileSample(paths: string[], maxFiles = 200, maxDirs = 60): string {
  const dirCounts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split('/').slice(0, -1);
    for (let i = 1; i <= Math.min(parts.length, 3); i++) {
      const d = parts.slice(0, i).join('/') + '/';
      dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
    }
  }
  const dirs = [...dirCounts]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, maxDirs)
    .map(([d, n]) => `${d} (${n})`);
  const depth = (p: string) => p.split('/').length;
  const files = [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, maxFiles).sort();
  const more = paths.length > maxFiles ? `\n… and ${paths.length - maxFiles} more files` : '';
  return `Directories (file counts):\n${dirs.join('\n')}\n\nFiles:\n${files.join('\n')}${more}`;
}

export interface CartographerDeps {
  ws: Workspace;
  emit: (e: EngineEvent) => void;
  settings: () => Settings;
  onDone(ok: boolean, summary: string): void;
}

export class Cartographer {
  private q: Query | null = null;
  // Kept open until the result: in-process MCP tools talk over the session's stdin.
  private readonly input = new InputQueue();
  private readonly abort = new AbortController();
  private agent: AgentInfo;
  private finished = false;

  constructor(private readonly d: CartographerDeps) {
    this.agent = {
      id: ATLAS_ID,
      name: 'Atlas',
      role: 'cartographer',
      hue: 5,
      status: 'starting',
      task: 'Map the codebase',
      nodeId: null,
      activity: 'Opening the project',
      startedAt: Date.now(),
    };
  }

  get info(): AgentInfo {
    return this.agent;
  }

  get running(): boolean {
    return !this.finished;
  }

  private update(patch: Partial<AgentInfo>): void {
    this.agent = { ...this.agent, ...patch };
    this.d.emit({ type: 'agent/upsert', agent: this.agent });
  }

  start(): void {
    const { ws, settings } = this.d;
    const s = settings();
    const tools = createCrewTools({
      ws,
      agentId: ATLAS_ID,
      source: 'cartographer',
      allowedOps: OP_NAMES,
      signal: this.abort.signal,
      canAsk: false,
      canNote: true,
    });
    this.input.push(cartographerPrompt(ws.info.name, describeMap(ws.map, ws.files), fileSample(ws.files.map((f) => f.path))));
    this.q = query({
      prompt: this.input,
      options: {
        ...leanOptions(ws.root),
        model: s.builderModel,
        effort: 'medium',
        systemPrompt: SYSTEM,
        tools: TOOLS,
        mcpServers: { iae: tools },
        allowedTools: [...TOOLS, ...crewToolNames({ canAsk: false, canNote: true })],
        permissionMode: 'dontAsk',
        persistSession: false,
        maxTurns: 80,
        abortController: this.abort,
      },
    });
    this.update({ status: 'thinking', activity: 'Reading the project' });
    void this.consume();
  }

  private async consume(): Promise<void> {
    const { ws, emit } = this.d;
    let summary = '';
    let ok = false;
    try {
      for await (const m of this.q!) {
        if (this.finished) break;
        if (m.type === 'assistant') {
          for (const block of m.message.content as { type: string; name?: string; input?: unknown }[]) {
            if (block.type !== 'tool_use' || !block.name) continue;
            const act = describeToolUse(ws.root, block.name, (block.input ?? {}) as Record<string, unknown>);
            emit({ type: 'agent/step', agentId: ATLAS_ID, step: { at: Date.now(), kind: act.kind, text: act.activity, ...(act.path ? { path: act.path } : {}) } });
            if (act.path && act.touch) emit({ type: 'files/touched', path: act.path, agentId: ATLAS_ID, action: act.touch });
            // Its own regroups can take away the node it stood on: then it stands nowhere until the next file.
            const here = this.agent.nodeId && ws.map.nodes[this.agent.nodeId] ? this.agent.nodeId : null;
            const nodeId = (act.path ? ownerOf(ws.map, act.path) : null) ?? here;
            this.update({ status: 'working', activity: plainActivity(block.name, act), file: act.path, nodeId });
          }
        } else if (m.type === 'result') {
          this.input.close();
          ok = m.subtype === 'success' && !m.is_error;
          summary = m.subtype === 'success' ? m.result.trim() : (m.errors ?? []).join('; ');
          log('atlas', `finished (${m.subtype}) in ${(m.duration_ms / 1000).toFixed(1)}s, $${m.total_cost_usd.toFixed(3)}`);
        }
      }
    } catch (e) {
      if (!this.finished) summary = errorText(e);
    }
    this.finish(ok, summary);
  }

  private finish(ok: boolean, summary: string): void {
    if (this.finished) return;
    this.finished = true;
    const { ws } = this.d;
    const sentence = summary.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (ok) ws.saveState({ cartographedAt: Date.now(), ...(sentence ? { summary: sentence } : {}) });
    this.update({ status: ok ? 'done' : 'failed', activity: undefined, file: undefined, endedAt: Date.now(), result: sentence || undefined });
    this.removeLater();
    this.d.onDone(ok, sentence);
  }

  async stop(): Promise<void> {
    if (this.finished) return;
    this.input.close();
    this.abort.abort();
    this.q?.close();
    this.finished = true;
    this.update({ status: 'stopped', activity: undefined, file: undefined, endedAt: Date.now() });
    this.removeLater();
  }

  /** Takes Atlas off the map shortly after it ends, unless the project has closed meanwhile. */
  private removeLater(): void {
    setTimeout(() => {
      if (!this.d.ws.isClosed) this.d.emit({ type: 'agent/remove', agentId: ATLAS_ID });
    }, REMOVE_AFTER_MS);
  }
}
