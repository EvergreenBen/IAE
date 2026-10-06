// What the palette can do, and how a query ranks it. Pure apart from the
// `run` closures, which the palette builds with the bridge and store.
import type { NodeKind } from '@shared/model';
import { fuzzy, fuzzyPath } from './fuzzy';

export type SectionId = 'commands' | 'nodes' | 'files' | 'claude' | 'projects';

export const SECTION_LABEL: Record<SectionId, string> = {
  commands: 'Commands',
  nodes: 'Go to',
  files: 'Files',
  claude: 'Claude Code',
  projects: 'Projects',
};

/** Shown in this order when the query is empty. */
const EMPTY_ORDER: SectionId[] = ['commands', 'nodes', 'claude', 'projects'];
const LIMIT: Record<SectionId, number> = { commands: 9, nodes: 6, files: 7, claude: 6, projects: 3 };
const EMPTY_LIMIT: Record<SectionId, number> = { commands: 9, nodes: 6, files: 0, claude: 4, projects: 3 };

export type IconName = 'plus' | 'folder' | 'meaning' | 'speak' | 'mic' | 'transcript' | 'settings' | 'exit' | 'slash' | 'chat';

export interface PaletteItem {
  id: string;
  icon?: IconName;
  section: SectionId;
  title: string;
  /** Secondary text after the title (a parent, a folder, a description). */
  hint?: string;
  /** Extra words that should find this item, matched with a small penalty. */
  keywords?: string;
  /** Files: full project-relative path; the title is its name. */
  path?: string;
  nodeKind?: NodeKind;
  shortcut?: string;
  /** On/off for toggles. */
  on?: boolean;
  /** Stay open after running (toggles). */
  keepOpen?: boolean;
  /** Hidden until searched for (e.g. nodes outside the current scope). */
  quiet?: boolean;
  run: () => void;
}

export interface Ranked {
  item: PaletteItem;
  score: number;
  /** Matched indices into the title. */
  titleHits: number[];
  /** Matched indices into the hint (files: the folder part). */
  hintHits: number[];
}

export interface Group {
  section: SectionId;
  rows: Ranked[];
}

function scoreItem(q: string, item: PaletteItem): Omit<Ranked, 'item'> | null {
  if (item.path) {
    const m = fuzzyPath(q, item.path);
    if (!m) return null;
    const cut = item.path.length - item.title.length;
    return {
      score: m.score,
      titleHits: m.indices.filter((i) => i >= cut).map((i) => i - cut),
      hintHits: m.indices.filter((i) => i < cut),
    };
  }
  const m = fuzzy(q, item.title);
  if (m) return { score: m.score + 2, titleHits: m.indices, hintHits: [] };
  const words = [item.keywords, item.hint].filter(Boolean).join(' ');
  if (words) {
    const k = fuzzy(q, words, 0);
    if (k) return { score: k.score - 10, titleHits: [], hintHits: [] };
  }
  return null;
}

/**
 * Rank items for a query and group them by section. With an empty query the
 * sections come in a fixed, useful order; otherwise the best match leads.
 */
export function rank(items: PaletteItem[], query: string): Group[] {
  const q = query.trim();
  if (!q) {
    return EMPTY_ORDER.map((section) => ({
      section,
      rows: items
        .filter((i) => i.section === section && !i.quiet)
        .slice(0, EMPTY_LIMIT[section])
        .map((item) => ({ item, score: 0, titleHits: [], hintHits: [] })),
    })).filter((g) => g.rows.length);
  }

  const bySection = new Map<SectionId, Ranked[]>();
  for (const item of items) {
    const r = scoreItem(q, item);
    if (!r) continue;
    const list = bySection.get(item.section) ?? [];
    list.push({ item, ...r });
    bySection.set(item.section, list);
  }
  const groups: Group[] = [];
  for (const [section, rows] of bySection) {
    rows.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
    groups.push({ section, rows: rows.slice(0, LIMIT[section]) });
  }
  groups.sort((a, b) => b.rows[0].score - a.rows[0].score);
  return groups;
}

/** "/review some args" → the command filter and the arguments to pass. */
export function parseSlash(query: string): { name: string; args: string } | null {
  const m = /^\/(\S*)(?:\s+(.*))?$/.exec(query.trim());
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}
