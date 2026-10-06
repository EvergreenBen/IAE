// ⌘K: go anywhere on the map, open any file, flip a mode, run a Claude Code
// command, or change settings. A small popover near the top third; fuzzy
// search; ↑↓ ↵ Esc. Also hosts the notice toasts for the project screen.
import { slug } from '@shared/map';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { bridge } from '../bridge';
import { FileGlyph } from '../map/glyphs';
import { ui, useIae } from '../state/store';
import { ESC, isMod, onEscape } from '../ui/escape';
import {
  BackIcon,
  ChatIcon,
  ExitIcon,
  FolderIcon,
  MicIcon,
  MeaningIcon,
  PlusIcon,
  SettingsIcon,
  SlashIcon,
  SpeakerIcon,
  TranscriptIcon,
} from '../ui/icons';
import { Kbd } from '../ui/Kbd';
import { NodeMark } from '../ui/NodeMark';
import { tildify } from '../home/relativeTime';
import { highlightRuns } from './fuzzy';
import { parseSlash, rank, SECTION_LABEL, type Group, type IconName, type PaletteItem, type Ranked } from './items';
import { Notices } from './Notices';
import { SettingsView } from './Settings';
import { usePaletteItems, type PaletteView } from './useItems';
import s from './Palette.module.css';

const ICONS: Record<IconName, (p: { size?: number }) => ReactNode> = {
  plus: PlusIcon,
  folder: FolderIcon,
  meaning: MeaningIcon,
  speak: SpeakerIcon,
  mic: MicIcon,
  transcript: TranscriptIcon,
  settings: SettingsIcon,
  exit: ExitIcon,
  slash: SlashIcon,
  chat: ChatIcon,
};

// ⌘N opens the palette straight onto "New project".
let pendingView: PaletteView | null = null;
let showView: ((v: PaletteView) => void) | null = null;

export function Palette() {
  const open = useIae((st) => st.paletteOpen);

  // ⌘K toggles from anywhere, including inside the editor and text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        e.stopPropagation();
        ui.setPalette(!useIae.getState().paletteOpen);
      } else if (k === 'n') {
        e.preventDefault();
        e.stopPropagation();
        if (showView) showView('new');
        else {
          pendingView = 'new';
          ui.setPalette(true);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{open && <PalettePanel key="palette" />}</AnimatePresence>
      <Notices />
    </MotionConfig>
  );
}

function PalettePanel() {
  const [view, setView] = useState<PaletteView>(() => {
    const v = pendingView ?? 'main';
    pendingView = null;
    return v;
  });
  useEffect(() => {
    showView = setView;
    return () => {
      showView = null;
    };
  }, []);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const leadName = useIae((st) => st.settings.leadName || 'Archie');
  const close = useCallback(() => ui.setPalette(false), []);

  const slashQ = parseSlash(query);
  const items = usePaletteItems(true, setView, slashQ?.args ?? '');

  const groups: Group[] = useMemo(() => {
    if (slashQ) {
      const claude = items.filter((i) => i.section === 'claude');
      if (slashQ.name) return rank(claude, slashQ.name);
      return claude.length ? [{ section: 'claude', rows: claude.map((item) => ({ item, score: 0, titleHits: [], hintHits: [] })) }] : [];
    }
    return rank(items, query);
  }, [items, query, slashQ?.name]);

  // Nothing matched: offer to hand the words to the lead instead.
  const fallback: Ranked | null = useMemo(() => {
    const q = query.trim();
    if (!q || groups.length) return null;
    const item: PaletteItem = {
      id: 'ask',
      icon: 'chat',
      section: 'commands',
      title: `Ask ${leadName}`,
      hint: `“${q}”`,
      run: () => void bridge.say(q, { via: 'text' }),
    };
    return { item, score: 0, titleHits: [], hintHits: [] };
  }, [groups.length, query, leadName]);

  const flat = useMemo(() => (fallback ? [fallback] : groups.flatMap((g) => g.rows)), [groups, fallback]);

  useEffect(() => setActive(0), [query, view]);

  useEffect(() => {
    if (view === 'main') inputRef.current?.focus();
  }, [view]);

  const back = useCallback(() => {
    setView('main');
    setQuery('');
  }, []);

  useEffect(
    () =>
      onEscape(() => {
        if (view !== 'main') back();
        else close();
        return true;
      }, ESC.palette),
    [view, back, close],
  );

  const run = (r: Ranked | undefined) => {
    if (!r) return;
    r.item.run();
    if (!r.item.keepOpen) close();
  };

  const move = (d: number) => {
    if (!flat.length) return;
    const next = (active + d + flat.length) % flat.length;
    setActive(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(flat[active]);
    }
  };

  let index = 0;
  const renderRow = (r: Ranked) => {
    const i = index++;
    return <Row key={r.item.id} r={r} index={i} active={i === active} onHover={() => setActive(i)} onRun={() => run(r)} />;
  };

  return (
    <>
      <motion.div className={s.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onMouseDown={close} />
      <motion.div
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        initial={{ opacity: 0, y: -6, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.99, transition: { duration: 0.12 } }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        {view === 'main' ? (
          <>
            <div className={s.inputRow}>
              <input
                ref={inputRef}
                className={s.input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Go to a part, find a file, or run a command…"
                aria-label="Search"
                aria-controls="palette-list"
                aria-activedescendant={flat[active] ? `palette-${active}` : undefined}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div ref={listRef} className={s.list} id="palette-list" role="listbox" aria-label="Results">
              {fallback ? (
                <div className={s.group}>
                  <div className={s.empty}>Nothing on the map by that name.</div>
                  {renderRow(fallback)}
                </div>
              ) : (
                groups.map((g) => (
                  <div key={g.section} className={s.group} role="group" aria-label={SECTION_LABEL[g.section]}>
                    <div className={s.label}>{SECTION_LABEL[g.section]}</div>
                    {g.rows.map(renderRow)}
                  </div>
                ))
              )}
            </div>
            <div className={s.foot}>
              <span className={s.keys}>
                <Kbd>↑↓</Kbd> move
              </span>
              <span className={s.keys}>
                <Kbd>↵</Kbd> open
              </span>
              <span className={s.keys}>
                <Kbd>esc</Kbd> close
              </span>
              <span className={s.footSpacer} />
              <span className={s.keys}>
                <Kbd>/</Kbd> Claude Code commands
              </span>
            </div>
          </>
        ) : (
          <>
            <div className={s.subHead}>
              <button type="button" className={s.back} onClick={back} aria-label="Back">
                <BackIcon size={15} />
              </button>
              <span className={s.subTitle}>{view === 'settings' ? 'Settings' : 'New project'}</span>
            </div>
            {view === 'settings' ? <SettingsView /> : <NewProject onDone={close} />}
          </>
        )}
      </motion.div>
    </>
  );
}

function Row({ r, index, active, onHover, onRun }: { r: Ranked; index: number; active: boolean; onHover: () => void; onRun: () => void }) {
  const { item } = r;
  let glyph: ReactNode = null;
  if (item.nodeKind) glyph = <NodeMark kind={item.nodeKind} size={15} />;
  else if (item.path) glyph = <FileGlyph path={item.path} size={15} />;
  else if (item.icon) {
    const Icon = ICONS[item.icon];
    glyph = <Icon size={15} />;
  }
  return (
    <div
      id={`palette-${index}`}
      data-index={index}
      role="option"
      aria-selected={active}
      className={active ? `${s.row} ${s.rowActive}` : s.row}
      onMouseMove={active ? undefined : onHover}
      onClick={onRun}
    >
      <span className={s.glyph}>{glyph}</span>
      <span className={s.title}>
        {highlightRuns(item.title, r.titleHits).map(([t, hit], i) => (hit ? <b key={i}>{t}</b> : <span key={i}>{t}</span>))}
      </span>
      {item.hint && (
        <span className={item.path ? `${s.hint} ${s.hintMono}` : s.hint}>
          {highlightRuns(item.hint, r.hintHits).map(([t, hit], i) => (hit ? <b key={i}>{t}</b> : <span key={i}>{t}</span>))}
        </span>
      )}
      <span className={s.end}>
        {item.on !== undefined && <span className={item.on ? s.on : s.off}>{item.on ? 'On' : 'Off'}</span>}
        {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
      </span>
    </div>
  );
}

function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge.getHome().then((h) => setParent(h.defaultParent), () => undefined);
  }, []);

  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.createProject(n, parent || undefined);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className={s.newView}>
      <input
        className={s.newInput}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void create();
          }
        }}
        placeholder="Name it, like Recipe Box"
        aria-label="Project name"
        spellCheck={false}
        disabled={busy}
      />
      <p className={s.newWhere}>
        {error ? <span className={s.newError}>{error}</span> : parent ? `${tildify(parent)}/${slug(name || 'new-project')}` : ' '}
      </p>
      <div className={s.foot}>
        <span className={s.keys}>
          <Kbd>↵</Kbd> {busy ? 'creating…' : 'create'}
        </span>
        <span className={s.keys}>
          <Kbd>esc</Kbd> back
        </span>
      </div>
    </div>
  );
}
