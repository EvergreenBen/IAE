// Builds the palette's items from the live store: nodes, files, commands,
// Claude Code commands & skills, and recent projects.
import { ancestorsOf, childrenOf } from '@shared/map';
import type { ProjectInfo, Settings, SlashCommandInfo } from '@shared/model';
import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../bridge';
import { closeLensThen } from '../lens/control';
import { ui, useIae } from '../state/store';
import { IS_MAC } from '../ui/escape';
import type { PaletteItem } from './items';

export type PaletteView = 'main' | 'settings' | 'new';

const mod = IS_MAC ? '⌘' : 'Ctrl ';

// Claude Code's commands rarely change within a session; keep the last list
// so the palette opens with it instantly, and refresh in the background.
let commandCache: { root: string; list: SlashCommandInfo[] } | null = null;

async function patchSettings(patch: Partial<Settings>) {
  const next = await bridge.setSettings(patch);
  useIae.setState({ settings: next });
}

export function usePaletteItems(open: boolean, setView: (v: PaletteView) => void, args: string): PaletteItem[] {
  const map = useIae((s) => s.map);
  const files = useIae((s) => s.files);
  const meaning = useIae((s) => s.meaning);
  const settings = useIae((s) => s.settings);
  const project = useIae((s) => s.project);
  const scopeId = useIae((s) => s.scopeId);
  const [commands, setCommands] = useState<SlashCommandInfo[]>(() => (commandCache && commandCache.root === project?.root ? commandCache.list : []));
  const [recent, setRecent] = useState<ProjectInfo[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const root = project?.root ?? '';
    bridge.listCommands().then(
      (list) => {
        commandCache = { root, list };
        if (alive) setCommands(list);
      },
      () => undefined,
    );
    bridge.getHome().then(
      (h) => alive && setRecent(h.recent),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [open, project?.root]);

  return useMemo(() => {
    const items: PaletteItem[] = [];
    const voice = settings.voice;

    // ── commands
    items.push(
      { id: 'cmd:new', icon: 'plus', section: 'commands', title: 'New project', keywords: 'create start blank', shortcut: `${mod}N`, keepOpen: true, run: () => setView('new') },
      {
        id: 'cmd:open',
        icon: 'folder',
        section: 'commands',
        title: 'Open project…',
        keywords: 'folder repo switch',
        run: () => {
          void bridge.pickFolder().then((root) => {
            if (root) void bridge.openProject(root);
          });
        },
      },
      {
        id: 'cmd:meaning',
        icon: 'meaning',
        section: 'commands',
        title: 'Meaning mode',
        hint: 'Files show what they do',
        keywords: 'explain notes names',
        shortcut: `${mod}M`,
        on: meaning,
        keepOpen: true,
        run: () => ui.toggleMeaning(),
      },
      {
        id: 'cmd:speak',
        icon: 'speak',
        section: 'commands',
        title: 'Speak replies',
        hint: `${settings.leadName} talks out loud`,
        keywords: 'voice tts audio sound mute',
        on: voice.speak,
        keepOpen: true,
        run: () => void patchSettings({ voice: { ...voice, speak: !voice.speak } }),
      },
      {
        id: 'cmd:handsfree',
        icon: 'mic',
        section: 'commands',
        title: 'Hands-free voice',
        hint: 'Talk without holding Space',
        keywords: 'mic microphone listen always vad',
        on: voice.handsFree,
        keepOpen: true,
        run: () => void patchSettings({ voice: { ...voice, handsFree: !voice.handsFree } }),
      },
      { id: 'cmd:transcript', icon: 'transcript', section: 'commands', title: 'Show transcript', keywords: 'history conversation log', shortcut: `${mod}J`, run: () => ui.setTranscript(true) },
      {
        id: 'cmd:settings',
        icon: 'settings',
        section: 'commands',
        title: 'Settings',
        hint: 'Name, models, autonomy',
        keywords: 'preferences lead name model builder autonomy permissions',
        keepOpen: true,
        run: () => setView('settings'),
      },
      { id: 'cmd:close', icon: 'exit', section: 'commands', title: 'Close project', hint: 'Back to Home', keywords: 'home exit leave', run: () => void bridge.closeProject() },
    );

    // ── nodes
    const ordered: string[] = [];
    const walk = (parent: string | null) => {
      for (const n of childrenOf(map, parent)) {
        ordered.push(n.id);
        walk(n.id);
      }
    };
    walk(null);
    for (const id of ordered) {
      const n = map.nodes[id];
      const parents = ancestorsOf(map, id);
      const hasChildren = childrenOf(map, id).length > 0;
      items.push({
        id: `node:${id}`,
        section: 'nodes',
        title: n.label,
        hint: parents.length ? parents.map((p) => p.label).join(' / ') : n.summary,
        keywords: [n.summary, n.tech?.join(' '), n.kind].filter(Boolean).join(' '),
        nodeKind: n.kind,
        quiet: n.parentId !== scopeId,
        run: () => closeLensThen(() => ui.focus(id, hasChildren ? 'enter' : 'show')),
      });
    }

    // ── files
    for (const f of files) {
      const slash = f.path.lastIndexOf('/');
      items.push({
        id: `file:${f.path}`,
        section: 'files',
        title: f.path.slice(slash + 1),
        hint: slash >= 0 ? f.path.slice(0, slash + 1) : '',
        path: f.path,
        run: () =>
          closeLensThen(() => {
            if (f.nodeId) ui.focus(f.nodeId, 'show');
            ui.openFile(f.path);
          }),
      });
    }

    // ── Claude Code
    for (const c of commands) {
      items.push({
        id: `claude:${c.name}`,
        icon: 'slash',
        section: 'claude',
        title: `/${c.name}`,
        hint: [c.description, args ? '' : c.argumentHint].filter(Boolean).join(' · '),
        keywords: c.description,
        run: () => void bridge.runCommand(args ? `/${c.name} ${args}` : `/${c.name}`),
      });
    }

    // ── other projects
    for (const p of recent) {
      if (p.root === project?.root) continue;
      items.push({
        id: `project:${p.root}`,
        icon: 'folder',
        section: 'projects',
        title: p.name,
        hint: p.summary ?? p.root,
        keywords: p.root,
        run: () => void bridge.openProject(p.root),
      });
    }

    return items;
  }, [map, files, meaning, settings, commands, recent, project?.root, scopeId, args, setView]);
}
