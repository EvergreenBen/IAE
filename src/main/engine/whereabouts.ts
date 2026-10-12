// Where a builder stands on the map, and whether it's thinking, read from its
// message stream. A write moves the figure to its part of the map as soon as
// the call names its file (while the change is still being written); a few
// quiet seconds with nothing in flight read as thinking; and a regrouped map
// never strands it on a node that's gone.

import { ancestorsOf, ownerOf } from '../../shared/map';
import type { AgentInfo, ArchMap } from '../../shared/model';
import { projectPath } from './activity';
import { streamedPath, THINKING, WRITERS } from './plain';

/** Results back and nothing new for this long: it's thinking (quick steps don't flicker the line). */
const THINK_AFTER_MS = 5_000;

/** The parts of a streamed message event this reads. */
export interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; name?: string };
  delta?: { type: string; partial_json?: string };
}

export interface WhereaboutsHost {
  root: string;
  map(): ArchMap;
  agent(): AgentInfo;
  /** Its job's node: where it stands when nothing better is known. */
  jobNode: string | null;
  update(patch: Partial<AgentInfo>): void;
  finished(): boolean;
}

export class Whereabouts {
  private thinkTimer: ReturnType<typeof setTimeout> | undefined;
  /** A writing tool whose input is streaming in, until it names its file. */
  private writing: { index: number; json: string } | null = null;
  /** Top-level tool calls not yet answered, and a tool call still streaming in: it isn't thinking while either is. */
  private readonly pending = new Set<string>();
  private streamingTool: number | null = null;
  /** The last file it touched (tool calls without one don't clear it), and the node it stood on with that node's ancestors. */
  private lastFile: string | null = null;
  private lineage: string[] = [];
  /** Its node went away and no other could be found: the next map change tries again. */
  private lost = false;

  constructor(private readonly h: WhereaboutsHost) {
    this.trace(h.agent().nodeId);
  }

  /** A session (re)starts: nothing is in flight. */
  reset(): void {
    this.pending.clear();
    this.streamingTool = null;
    this.writing = null;
    this.trace(this.h.agent().nodeId);
  }

  stop(): void {
    clearTimeout(this.thinkTimer);
  }

  /** Called with every update before it applies: keeps the last file and the lineage of a new node. */
  noting(patch: Partial<AgentInfo>): void {
    if (patch.file) this.lastFile = patch.file;
    if (patch.nodeId !== undefined && patch.nodeId !== this.h.agent().nodeId) {
      this.lost = false;
      this.trace(patch.nodeId);
    }
  }

  private trace(nodeId: string | null): void {
    const map = this.h.map();
    if (nodeId && map.nodes[nodeId]) this.lineage = [nodeId, ...ancestorsOf(map, nodeId).map((n) => n.id).reverse()];
  }

  /**
   * Where to stand: the node that owns the file in hand, else where it already
   * is (while that's still on the map), else the owner of the last file it
   * touched, else the nearest part of where it stood that's still there, else
   * its job's node.
   */
  home(path?: string | null): string | null {
    const map = this.h.map();
    const owner = path ? ownerOf(map, path) : null;
    if (owner) return owner;
    const here = this.h.agent().nodeId;
    if (here && map.nodes[here]) return here;
    const last = this.lastFile ? ownerOf(map, this.lastFile) : null;
    if (last) return last;
    const kept = this.lineage.find((id) => map.nodes[id]);
    if (kept) return kept;
    return this.h.jobNode && map.nodes[this.h.jobNode] ? this.h.jobNode : null;
  }

  /** The map changed under it (the cartographer regrouped things): if its node is gone, it stands somewhere real. */
  rehome(): void {
    if (this.h.finished()) return;
    const id = this.h.agent().nodeId;
    if (id ? this.h.map().nodes[id] : !this.lost) return;
    const next = this.home();
    if (next === id) return;
    this.h.update({ nodeId: next });
    this.lost = next === null;
  }

  /** A complete top-level tool call arrived: it's in flight until its result comes back. */
  called(id: string | undefined): void {
    clearTimeout(this.thinkTimer);
    this.writing = null;
    this.streamingTool = null;
    if (id) this.pending.add(id);
  }

  /** Top-level results came back. */
  answered(content: unknown): void {
    for (const b of Array.isArray(content) ? (content as { type?: string; tool_use_id?: string }[]) : []) {
      if (b?.type === 'tool_result' && b.tool_use_id) this.pending.delete(b.tool_use_id);
    }
    this.armThinking();
  }

  /** Nothing in flight and nothing streaming: after a few quiet seconds it reads as thinking. */
  private armThinking(): void {
    clearTimeout(this.thinkTimer);
    if (this.pending.size || this.streamingTool !== null) return;
    this.thinkTimer = setTimeout(() => {
      if (!this.h.finished() && this.h.agent().status === 'working' && !this.pending.size && this.streamingTool === null) this.h.update({ status: 'thinking', activity: THINKING });
    }, THINK_AFTER_MS);
  }

  /** A top-level stream event. */
  stream(ev: StreamEvent): void {
    if (ev.type === 'content_block_stop' && ev.index === this.streamingTool) {
      this.streamingTool = null;
      return;
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type !== 'tool_use') {
      // It's thinking or talking: that counts as thinking once it has gone on a while.
      this.armThinking();
      return;
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      clearTimeout(this.thinkTimer);
      this.streamingTool = ev.index ?? 0;
      const writes = WRITERS.has(ev.content_block.name ?? '');
      this.writing = writes ? { index: ev.index ?? 0, json: '' } : null;
      if (writes && this.h.agent().status !== 'waiting') this.h.update({ status: 'working', activity: 'Making changes' });
      return;
    }
    const w = this.writing;
    if (!w || ev.type !== 'content_block_delta' || ev.index !== w.index || ev.delta?.type !== 'input_json_delta') return;
    w.json += ev.delta.partial_json ?? '';
    const raw = streamedPath(w.json);
    if (raw === null) {
      // The path comes first; past this, it isn't coming.
      if (w.json.length > 2000) this.writing = null;
      return;
    }
    this.writing = null;
    const path = projectPath(this.h.root, raw);
    if (path && this.h.agent().status !== 'waiting') this.h.update({ nodeId: this.home(path), file: path });
  }
}
