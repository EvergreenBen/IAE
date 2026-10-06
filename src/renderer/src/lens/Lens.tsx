// The lens: a sheet that rises over the map when you open a file. Read and
// edit the code (or the .env as rows), switch to what it means, or ask the
// lead to change it. Esc closes it and leaves the camera where it was.
import { ownerOf } from '@shared/map';
import type { FileContent } from '@shared/model';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { bridge } from '../bridge';
import { ui, useIae } from '../state/store';
import { ESC, IS_MAC, isMod, onEscape } from '../ui/escape';
import { CloseIcon, WrapIcon } from '../ui/icons';
import { Kbd } from '../ui/Kbd';
import { NodeMark } from '../ui/NodeMark';
import { Segmented } from '../ui/Segmented';
import { AskBar } from './AskBar';
import { CodeView } from './CodeView';
import { registerLensCloser } from './control';
import { EnvEditor } from './EnvEditor';
import { detectEol, fromLf, toLf, type Eol } from './eol';
import { isEnvFile, wrapsByDefault } from './languages';
import { Meaning } from './Meaning';
import { rememberWrap, wrapFor } from './wrapPref';
import s from './Lens.module.css';

type Mode = 'code' | 'meaning';
const EASE = [0.22, 1, 0.36, 1] as const;

export function Lens() {
  const path = useIae((st) => st.openFile);
  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{path && <LensSheet key="lens" path={path} />}</AnimatePresence>
    </MotionConfig>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LensSheet({ path }: { path: string }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<'saved' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { then: () => void }>(null);
  const [mode, setMode] = useState<Mode>(() => (useIae.getState().meaning ? 'meaning' : 'code'));
  /** Soft wrap chosen in this lens; null follows the remembered default for this kind of file. */
  const [wrapChoice, setWrapChoice] = useState<boolean | null>(null);
  const [agentNote, setAgentNote] = useState<{ name: string; hue: number } | null>(null);
  const openedAt = useRef(Date.now());

  const meaningMode = useIae((st) => st.meaning);
  const nodeId = useIae((st) => st.files.find((f) => f.path === path)?.nodeId ?? ownerOf(st.map, path));
  const node = useIae((st) => (nodeId ? st.map.nodes[nodeId] : undefined));
  const touch = useIae((st) => {
    for (let i = st.touches.length - 1; i >= 0; i--) if (st.touches[i].path === path) return st.touches[i];
    return null;
  });

  const dirty = file !== null && !file.unreadable && draft !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // The editors report every keystroke here synchronously, so async work can
  // tell whether something was typed while it waited (state lags a render).
  const draftRef = useRef('');
  const savedRef = useRef('');
  // The file's own line endings: the editors work in "\n", saving restores these.
  const eolRef = useRef<Eol>('\n');
  const loadSeq = useRef(0);

  const edit = useCallback((text: string) => {
    draftRef.current = text;
    setDraft(text);
  }, []);

  // ── load ──────────────────────────────────────────────────────────────────
  const load = useCallback(
    (quiet = false) => {
      const seq = ++loadSeq.current;
      const typed = draftRef.current;
      if (!quiet) {
        // A fresh open starts clean, whatever the previous file held.
        draftRef.current = savedRef.current = '';
        setFile(null);
        setLoadError(null);
      }
      bridge.readFile(path).then(
        (fc) => {
          if (seq !== loadSeq.current) return; // a newer read, or the lens moved on
          // A quiet reload (an agent touched the file) never clobbers edits, including keystrokes typed during the read.
          if (quiet && (draftRef.current !== savedRef.current || draftRef.current !== typed)) return;
          const text = fc.unreadable ? '' : toLf(fc.content);
          eolRef.current = detectEol(fc.content);
          draftRef.current = savedRef.current = text;
          setFile(fc);
          setDraft(text);
          setSaved(text);
        },
        (err: unknown) => {
          if (seq === loadSeq.current && !quiet) setLoadError(err instanceof Error ? err.message : String(err));
        },
      );
    },
    [path],
  );

  useEffect(() => {
    openedAt.current = Date.now();
    setConfirm(null);
    setSaveError(null);
    setAgentNote(null);
    setWrapChoice(null);
    load();
    return () => {
      loadSeq.current++;
    };
  }, [load]);

  // Follow ⌘M while open.
  const firstMeaning = useRef(true);
  useEffect(() => {
    if (firstMeaning.current) {
      firstMeaning.current = false;
      return;
    }
    setMode(meaningMode ? 'meaning' : 'code');
  }, [meaningMode]);

  // An agent touched this file while it's open: follow along if nothing is unsaved.
  useEffect(() => {
    if (!touch || touch.at < openedAt.current || touch.action === 'read') return;
    const agent = useIae.getState().agents[touch.agentId];
    setAgentNote({ name: agent?.name ?? 'An agent', hue: agent?.hue ?? 0 });
    if (draftRef.current === savedRef.current) load(true);
    const t = setTimeout(() => setAgentNote(null), 6000);
    return () => clearTimeout(t);
  }, [touch, load]);

  // ── save / close ──────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!file || file.unreadable || saving) return false;
    if (draft === saved) return true;
    setSaving(true);
    setSaveError(null);
    try {
      await bridge.writeFile(path, fromLf(draft, eolRef.current));
      savedRef.current = draft;
      setSaved(draft);
      setFlash('saved');
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [file, saving, draft, saved, path]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const leave = useCallback((then?: () => void) => {
    ui.openFile(null);
    then?.();
  }, []);

  const requestClose = useCallback(
    (then?: () => void) => {
      if (dirtyRef.current) setConfirm({ then: () => leave(then) });
      else leave(then);
    },
    [leave],
  );

  const saveAndClose = async () => {
    const ok = await save();
    if (ok) confirm?.then();
  };

  // ⌘S anywhere in the lens; Esc closes (or backs out of the unsaved prompt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        void save();
      } else if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyZ' && canWrapRef.current) {
        e.preventDefault();
        e.stopPropagation();
        toggleWrapRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [save]);

  useEffect(
    () =>
      onEscape(() => {
        if (confirm) setConfirm(null);
        else requestClose();
        return true;
      }, ESC.lens),
    [confirm, requestClose],
  );

  useEffect(() => registerLensCloser(requestClose), [requestClose]);

  const goNode = (id: string) => requestClose(() => ui.focus(id, 'show'));

  // ── render ────────────────────────────────────────────────────────────────
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = path.slice(slash + 1);
  const env = isEnvFile(path, file?.language);
  const prose = wrapsByDefault(path, file?.language);
  const wrap = wrapChoice ?? wrapFor(prose);
  const canWrap = mode === 'code' && !!file && !file.unreadable && !env && !loadError;
  const toggleWrap = () => {
    const next = !wrap;
    setWrapChoice(next);
    rememberWrap(prose, next);
  };
  const canWrapRef = useRef(canWrap);
  canWrapRef.current = canWrap;
  const toggleWrapRef = useRef(toggleWrap);
  toggleWrapRef.current = toggleWrap;

  let body: ReactNode = null;
  if (mode === 'meaning') {
    body = <Meaning path={path} nodeId={nodeId} onGoto={goNode} />;
  } else if (loadError) {
    body = (
      <div className={s.calm}>
        <p className={s.calmTitle}>This file couldn't be opened.</p>
        <p className={s.calmBody}>
          <code>{loadError}</code>
        </p>
      </div>
    );
  } else if (!file) {
    body = (
      <motion.p className={s.opening} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
        Opening…
      </motion.p>
    );
  } else if (file.unreadable) {
    body = (
      <div className={s.calm}>
        <p className={s.calmTitle}>Nothing to read here.</p>
        <p className={s.calmBody}>{formatSize(file.size)}. It's binary or too large to show, so it stays as it is.</p>
        <button type="button" className={s.ghostBtn} onClick={() => void bridge.revealFile(path)}>
          {IS_MAC ? 'Show in Finder' : 'Show in folder'}
        </button>
      </div>
    );
  } else if (env) {
    body = <EnvEditor key={path} path={path} text={draft} saved={saved} onChange={edit} />;
  } else {
    body = <CodeView key={path} path={path} language={file.language} doc={draft} onChange={edit} wrap={wrap} />;
  }

  return (
    <>
      <motion.div
        className={s.scrim}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.24, ease: EASE }}
        onClick={() => requestClose()}
      />
      <motion.div
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.28, ease: EASE }}
      >
        <header className={s.head}>
          <div className={s.path} title={path}>
            {dir && (
              // RTL box + a trailing left-to-right mark: long folders lose their start ("…/auth/"), never their end.
              <span className={s.dir} dir="rtl">
                {dir + '\u200E'}
              </span>
            )}
            <span className={s.name}>{name}</span>
            <span className={s.state}>
              <AnimatePresence initial={false}>
                {dirty && (
                  <motion.span key="dirty" className={s.dirty} title="Unsaved changes" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} />
                )}
              </AnimatePresence>
            </span>
          </div>
          {node && (
            <button type="button" className={s.owner} onClick={() => goNode(node.id)} title={`Show ${node.label} on the map`}>
              <NodeMark kind={node.kind} />
              {node.label}
            </button>
          )}
          <span className={s.spacer} />
          <AnimatePresence>
            {flash && !dirty && (
              <motion.span key="saved" className={s.saved} initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                Saved
              </motion.span>
            )}
          </AnimatePresence>
          {canWrap && (
            <button
              type="button"
              className={wrap ? `${s.tool} ${s.toolOn}` : s.tool}
              onClick={toggleWrap}
              aria-pressed={wrap}
              aria-label="Wrap long lines"
              title={`${wrap ? 'Stop wrapping' : 'Wrap long lines'} (${IS_MAC ? '⌥Z' : 'Alt+Z'})`}
            >
              <WrapIcon size={15} />
            </button>
          )}
          <Segmented<Mode>
            label="View"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'code', label: env ? 'Values' : 'Code' },
              { value: 'meaning', label: 'Meaning', hint: `What this file is for (${IS_MAC ? '⌘' : 'Ctrl+'}M everywhere)` },
            ]}
          />
          <button type="button" className={s.close} onClick={() => requestClose()} aria-label="Close" title="Close (Esc)">
            <CloseIcon size={15} />
          </button>
        </header>

        <div className={s.body}>{body}</div>

        <footer className={s.foot}>
          {confirm ? (
            <div className={s.confirm} role="alertdialog" aria-label="Unsaved changes">
              <span className={s.confirmText}>
                Save your changes to <code>{name}</code>?
              </span>
              <span className={s.spacer} />
              <button type="button" className={s.textBtn} onClick={() => setConfirm(null)}>
                Keep editing
              </button>
              <button type="button" className={s.textBtn} onClick={() => confirm.then()}>
                Don't save
              </button>
              <button type="button" className={s.primaryBtn} onClick={() => void saveAndClose()} autoFocus>
                Save
              </button>
            </div>
          ) : (
            <AskBar path={path}>
              <AnimatePresence>
                {saveError ? (
                  <motion.span key="err" className={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    Couldn't save: {saveError}
                  </motion.span>
                ) : agentNote ? (
                  <motion.span key="agent" className={s.agentNote} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <span className={s.agentDot} style={{ background: `var(--agent-${agentNote.hue % 6})` }} />
                    {agentNote.name} is working in this file
                  </motion.span>
                ) : dirty ? (
                  <motion.span key="hint" className={s.hint} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Kbd>{IS_MAC ? '⌘S' : 'Ctrl S'}</Kbd> to save
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </AskBar>
          )}
        </footer>
      </motion.div>
    </>
  );
}
