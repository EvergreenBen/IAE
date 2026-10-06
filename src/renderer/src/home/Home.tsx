// Home: the calm place between projects. Archie, one question, two ways in,
// and the projects you were last working on.
import type { HomeInfo } from '@shared/bridge';
import { projectFolderName } from '@shared/map';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Archie, type ArchieState } from '../avatar/Archie';
import { bridge } from '../bridge';
import { Notices } from '../palette/Notices';
import { useIae } from '../state/store';
import { ESC, isMod, onEscape } from '../ui/escape';
import { relativeTime, tildify } from './relativeTime';
import s from './Home.module.css';

const rise = (i: number) => ({
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.42, delay: 0.05 + i * 0.07, ease: [0.22, 1, 0.36, 1] as const },
});

/** Wrap a path for a right-to-left box, so a long one loses its start ("…/Projects/recipe-box"), never its folder name. */
const tail = (path: string) => `\u200E${path}\u200E`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function Home() {
  const [home, setHome] = useState<HomeInfo | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** How many recents fit whole in the space left (null: all of them). */
  const [fit, setFit] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    bridge.getHome().then(
      (h) => {
        if (!alive) return;
        setHome(h);
        useIae.setState({ claude: h.claude, claudeDetail: h.claudeDetail });
      },
      () => alive && setHome({ recent: [], defaultParent: '', claude: 'unknown' }),
    );
    return () => {
      alive = false;
    };
  }, []);

  const recent = home?.recent ?? [];

  // Never cut a project in half above the footer: show the ones that fit whole,
  // and "N more" beside the label for the rest (which then scroll in the same space).
  useLayoutEffect(() => {
    const sec = sectionRef.current;
    const list = listRef.current;
    if (!sec || !list) return;
    const measure = () => {
      const room = sec.clientHeight - (list.getBoundingClientRect().top - sec.getBoundingClientRect().top);
      const bottoms = Array.from(list.children, (li) => (li as HTMLElement).offsetTop + (li as HTMLElement).offsetHeight);
      if (!bottoms.length || bottoms[bottoms.length - 1] <= room) return setFit(null);
      let n = 0;
      while (n < bottoms.length && bottoms[n] <= room) n++;
      setFit(Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sec);
    return () => ro.disconnect();
  }, [recent]);

  const collapsed = !showAll && fit !== null;
  const shown = collapsed ? fit : recent.length;
  const listHeight = (() => {
    if (!collapsed || !listRef.current) return undefined;
    const last = listRef.current.children[fit - 1] as HTMLElement | undefined;
    return last ? last.offsetTop + last.offsetHeight : undefined;
  })();

  // Arrowing past the last one shown opens the rest, and keeps the choice in view.
  const keyed = useRef(false);
  useEffect(() => {
    if (active === null || !keyed.current) return;
    if (active >= shown) return setShowAll(true); // scrolls on the next pass, once the rest show
    keyed.current = false;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, shown]);

  const open = useCallback(async (root: string) => {
    setBusy(root);
    setError(null);
    try {
      await bridge.openProject(root);
    } catch (err) {
      setError(`Couldn't open that folder. ${message(err)}`);
      setBusy(null);
    }
  }, []);

  const openFolder = useCallback(async () => {
    setError(null);
    const root = await bridge.pickFolder();
    if (root) await open(root);
  }, [open]);

  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy('new');
    setError(null);
    try {
      await bridge.createProject(n, home?.defaultParent || undefined);
    } catch (err) {
      setError(`Couldn't create ${n}. ${message(err)}`);
      setBusy(null);
    }
  };

  const startNaming = () => {
    setNaming(true);
    setError(null);
    nameRef.current?.focus();
  };

  useEffect(() => {
    if (!naming) return;
    return onEscape(() => {
      setNaming(false);
      setName('');
      return true;
    }, ESC.field);
  }, [naming]);

  // ⌘N new, ⌘O open, ↑↓ ↵ through recents.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMod(e) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        startNaming();
        return;
      }
      if (isMod(e) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openFolder();
        return;
      }
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (typing || !recent.length || busy) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        keyed.current = true;
        setActive((a) => (a === null ? (d > 0 ? 0 : recent.length - 1) : (a + d + recent.length) % recent.length));
      } else if (e.key === 'Enter' && active !== null && recent[active]) {
        e.preventDefault();
        void open(recent[active].root);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recent, active, busy, open, openFolder]);

  const archie: ArchieState = busy ? 'thinking' : naming && name ? 'listening' : 'idle';
  const target = home?.defaultParent ? `${tildify(home.defaultParent)}/${projectFolderName(name || 'New project')}` : '';

  return (
    <MotionConfig reducedMotion="user">
    <div className={s.home}>
      <div className={`${s.drag} drag-region`} />

      <main className={s.center}>
        <motion.div className={s.archie} {...rise(0)}>
          <Archie size={96} state={archie} />
        </motion.div>

        <motion.h1 className={s.title} {...rise(1)}>
          What are we building?
        </motion.h1>

        <motion.div className={s.actions} {...rise(2)}>
          <AnimatePresence mode="popLayout" initial={false}>
            {naming ? (
              <motion.form
                key="name"
                className={s.nameForm}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.18 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <div className={s.nameField}>
                  <input
                    ref={nameRef}
                    autoFocus
                    className={s.nameInput}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => !name.trim() && setNaming(false)}
                    placeholder="Name it, like Recipe Box"
                    aria-label="Project name"
                    spellCheck={false}
                    disabled={busy === 'new'}
                  />
                  <button type="submit" className={s.create} disabled={!name.trim() || busy === 'new'}>
                    {busy === 'new' ? 'Creating…' : 'Create'}
                  </button>
                </div>
                {target && <p className={s.where}>{target}</p>}
              </motion.form>
            ) : (
              <motion.div key="buttons" className={s.buttons} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
                <button type="button" className={s.primary} onClick={startNaming} title="New project (⌘N)">
                  New project
                </button>
                <button type="button" className={s.secondary} onClick={() => void openFolder()} title="Open a folder (⌘O)">
                  Open a folder…
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        <AnimatePresence>
          {error && (
            <motion.p className={s.error} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert">
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        {home && (
          <motion.section ref={sectionRef} className={s.recent} {...rise(3)} aria-label="Recent projects">
            {recent.length > 0 ? (
              <>
                <div className={s.labelRow}>
                  <h2 className={s.label}>Recent</h2>
                  {collapsed && (
                    <button type="button" className={s.more} onClick={() => setShowAll(true)}>
                      {recent.length - shown} more
                    </button>
                  )}
                </div>
                <ul
                  ref={listRef}
                  className={[s.list, collapsed && s.listCut, showAll && fit !== null && s.listScroll].filter(Boolean).join(' ')}
                  style={listHeight !== undefined ? { maxHeight: listHeight } : undefined}
                  role="listbox"
                  aria-label="Recent projects"
                  onMouseLeave={() => setActive(null)}
                >
                  {recent.map((p, i) => (
                    <li
                      key={p.root}
                      role="option"
                      aria-selected={active === i}
                      aria-hidden={i >= shown || undefined}
                      className={[s.item, active === i && s.active, busy && busy !== p.root && s.dim, i >= shown && s.beyond].filter(Boolean).join(' ')}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => !busy && void open(p.root)}
                    >
                      <div className={s.itemMain}>
                        <span className={s.name}>{p.name}</span>
                        {p.summary && <span className={s.summary}>{p.summary}</span>}
                        <span className={s.path} dir="rtl" title={p.root}>
                          {tail(tildify(p.root))}
                        </span>
                      </div>
                      <span className={s.time}>{busy === p.root ? 'Opening…' : relativeTime(p.lastOpenedAt)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className={s.none}>Your projects will gather here. Start something new, or open a folder you're already working in.</p>
            )}
          </motion.section>
        )}
      </main>

      <ClaudeLine />
      <Notices />
    </div>
    </MotionConfig>
  );
}

function ClaudeLine() {
  const status = useIae((st) => st.claude);
  const detail = useIae((st) => st.claudeDetail);
  let dot = s.dotWait;
  let text: ReactNode = 'Looking for Claude Code…';
  if (status === 'ready') {
    dot = s.dotOk;
    text = 'Connected to Claude Code';
  } else if (status === 'unavailable') {
    dot = s.dotWarn;
    text = (
      <>
        Claude Code isn't connected. Install it, then run <code>claude</code> once in a terminal to sign in.
      </>
    );
  }
  return (
    <footer className={s.claude} title={detail}>
      <span className={`${s.dot} ${dot}`} aria-hidden="true" />
      <span>{text}</span>
      {status === 'unavailable' && detail && <span className={s.detail}>{detail}</span>}
    </footer>
  );
}
