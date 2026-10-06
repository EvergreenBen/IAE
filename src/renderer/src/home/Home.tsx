// Home: the calm place between projects. Archie, one question, two ways in,
// and the projects you were last working on.
import type { HomeInfo } from '@shared/bridge';
import { slug } from '@shared/map';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function Home() {
  const [home, setHome] = useState<HomeInfo | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

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
  const target = home?.defaultParent ? `${tildify(home.defaultParent)}/${slug(name || 'new-project')}` : '';

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
          <motion.section className={s.recent} {...rise(3)} aria-label="Recent projects">
            {recent.length > 0 ? (
              <>
                <h2 className={s.label}>Recent</h2>
                <ul className={s.list} role="listbox" aria-label="Recent projects" onMouseLeave={() => setActive(null)}>
                  {recent.map((p, i) => (
                    <li
                      key={p.root}
                      role="option"
                      aria-selected={active === i}
                      className={[s.item, active === i && s.active, busy && busy !== p.root && s.dim].filter(Boolean).join(' ')}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => !busy && void open(p.root)}
                    >
                      <div className={s.itemMain}>
                        <span className={s.name}>{p.name}</span>
                        {p.summary && <span className={s.summary}>{p.summary}</span>}
                        <span className={s.path}>{tildify(p.root)}</span>
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
