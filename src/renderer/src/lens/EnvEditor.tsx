// The .env editor: one calm row per variable. Values are masked until you ask,
// comments stay where they were, and the file round-trips byte-for-byte for
// everything you didn't touch. "Edit as text" drops to the raw file.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { CodeView } from './CodeView';
import {
  addEntry,
  duplicateKeys,
  entriesOf,
  headingText,
  insertItem,
  parseEnv,
  removeItem,
  serializeEnv,
  updateEntry,
  type EnvDoc,
  type EnvEntry,
  type EnvItem,
  type EnvOther,
} from './env';
import { AddRow, Row } from './EnvRows';
import s from './EnvEditor.module.css';

interface Props {
  path: string;
  /** Current text (the lens's draft). */
  text: string;
  /** Text as last saved, to mark what changed. */
  saved: string;
  onChange: (text: string) => void;
}

interface Section {
  id: string;
  title: string | null;
  more: string[];
  rows: (EnvEntry | EnvOther)[];
}

function sectionsOf(doc: EnvDoc): Section[] {
  const out: Section[] = [{ id: 'top', title: null, more: [], rows: [] }];
  for (const it of doc.items) {
    if (it.kind === 'blank') continue;
    if (it.kind === 'comment') {
      const t = headingText(it.text);
      if (!t) continue;
      const last = out[out.length - 1];
      if (last.title && !last.rows.length) last.more.push(t);
      else out.push({ id: it.id, title: t, more: [], rows: [] });
      continue;
    }
    out[out.length - 1].rows.push(it);
  }
  return out.filter((sec) => sec.title || sec.rows.length);
}

const ROW_MOTION = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
};

export function EnvEditor({ path, text, saved, onChange }: Props) {
  const [doc, setDoc] = useState(() => parseEnv(text));
  const [raw, setRaw] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ item: EnvItem; index: number; key: string } | null>(null);

  // Adopt changes made elsewhere: the raw view, a reload, a revert.
  useEffect(() => {
    if (text !== serializeEnv(doc)) setDoc(parseEnv(text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(() => setRemoved(null), 7000);
    return () => clearTimeout(t);
  }, [removed]);

  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 1600);
    return () => clearTimeout(t);
  }, [fresh]);

  const commit = (next: EnvDoc) => {
    setDoc(next);
    onChange(serializeEnv(next));
  };

  const baseline = useMemo(() => new Map(entriesOf(parseEnv(saved)).map((e) => [e.key, e.value])), [saved]);
  const entries = entriesOf(doc);
  const dups = useMemo(() => duplicateKeys(doc), [doc]);
  const isChanged = (e: EnvEntry) => baseline.get(e.key) !== e.value;
  const changedCount = entries.filter(isChanged).length + [...baseline.keys()].filter((k) => !entries.some((e) => e.key === k)).length;
  const sections = sectionsOf(doc);

  const toggleShown = (id: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = (e: EnvEntry) => {
    const r = removeItem(doc, e.id);
    if (!r.removed) return;
    setRemoved({ item: r.removed, index: r.index, key: e.key });
    commit(r.doc);
  };

  const undo = () => {
    if (!removed) return;
    commit(insertItem(doc, removed.item, removed.index));
    setFresh(removed.item.id);
    setRemoved(null);
  };

  const add = (key: string, value: string) => {
    const r = addEntry(doc, key, value);
    commit(r.doc);
    setShown((prev) => new Set(prev).add(r.id));
    setFresh(r.id);
  };

  const count = entries.length;

  return (
    <div className={s.root}>
      <div className={s.bar}>
        <span className={s.count}>
          {count === 1 ? '1 variable' : `${count} variables`}
          {changedCount > 0 && <span className={s.changedCount}> · {changedCount} changed</span>}
        </span>
        <AnimatePresence>
          {removed && (
            <motion.span className={s.undo} initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              Removed <code>{removed.key}</code>
              <button type="button" className={s.link} onClick={undo}>
                Undo
              </button>
            </motion.span>
          )}
        </AnimatePresence>
        <span className={s.spacer} />
        {!raw && (
          <button type="button" className={s.link} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Hide values' : 'Show values'}
          </button>
        )}
        <button type="button" className={s.link} onClick={() => setRaw((v) => !v)}>
          {raw ? 'Edit as list' : 'Edit as text'}
        </button>
      </div>

      {raw ? (
        <div className={s.raw}>
          <CodeView path={path} language="env" doc={text} onChange={onChange} autoFocus />
        </div>
      ) : (
        <div className={s.scroll}>
          <div className={s.list}>
            {sections.length === 0 && <p className={s.empty}>No variables yet. Add the first one below.</p>}
            {sections.map((sec) => (
              <section key={sec.id} className={s.section}>
                {sec.title && (
                  <header className={s.heading}>
                    <span>{sec.title}</span>
                    {sec.more.map((m, i) => (
                      <span key={i} className={s.headingMore}>
                        {m}
                      </span>
                    ))}
                  </header>
                )}
                <AnimatePresence initial={false}>
                  {sec.rows.map((row) =>
                    row.kind === 'other' ? (
                      <motion.div key={row.id} {...ROW_MOTION} className={s.otherWrap}>
                        <div className={s.other} title="Kept as written">
                          {row.raw}
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div key={row.id} {...ROW_MOTION} className={s.rowWrap}>
                        <Row
                          entry={row}
                          masked={!showAll && !shown.has(row.id) && editing !== row.id}
                          revealed={showAll || shown.has(row.id)}
                          changed={isChanged(row)}
                          duplicate={dups.has(row.key)}
                          fresh={fresh === row.id}
                          autoFocusValue={editing === row.id}
                          onReveal={() => setEditing(row.id)}
                          onToggle={() => toggleShown(row.id)}
                          onDoneEditing={() => setEditing((cur) => (cur === row.id ? null : cur))}
                          onPatch={(patch) => commit(updateEntry(doc, row.id, patch))}
                          onRemove={() => remove(row)}
                        />
                      </motion.div>
                    ),
                  )}
                </AnimatePresence>
              </section>
            ))}
            <AddRow onAdd={add} existing={new Set(entries.map((e) => e.key))} />
          </div>
        </div>
      )}
    </div>
  );
}
