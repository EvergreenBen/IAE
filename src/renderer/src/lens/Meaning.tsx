// What a file means, in plain words: its one-line note, Claude's explanation,
// where it lives on the map, and what its node talks to.
import { ancestorsOf } from '@shared/map';
import type { ArchEdge, ArchMap, ArchNode } from '@shared/model';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../bridge';
import { useIae } from '../state/store';
import { NodeMark } from '../ui/NodeMark';
import s from './Meaning.module.css';

interface Link {
  node: ArchNode;
  labels: string[];
}

/** Edges of the node, or of its nearest ancestor that has any. */
function connections(map: ArchMap, nodeId: string | null): { usedBy: Link[]; talksTo: Link[]; via: ArchNode | null } {
  let cur = nodeId;
  let via: ArchNode | null = null;
  const edges = Object.values(map.edges);
  while (cur && map.nodes[cur]) {
    const id = cur;
    const fold = (list: ArchEdge[], other: (e: ArchEdge) => string): Link[] => {
      const by = new Map<string, Link>();
      for (const e of list) {
        const n = map.nodes[other(e)];
        if (!n) continue;
        const link = by.get(n.id) ?? { node: n, labels: [] };
        if (e.label && !link.labels.includes(e.label)) link.labels.push(e.label);
        by.set(n.id, link);
      }
      return [...by.values()];
    };
    const usedBy = fold(
      edges.filter((e) => e.to === id),
      (e) => e.from,
    );
    const talksTo = fold(
      edges.filter((e) => e.from === id),
      (e) => e.to,
    );
    if (usedBy.length || talksTo.length) return { usedBy, talksTo, via };
    const parent = map.nodes[id].parentId;
    via = parent ? map.nodes[parent] ?? null : null;
    cur = parent;
  }
  return { usedBy: [], talksTo: [], via: null };
}

export function Meaning({ path, nodeId, onGoto }: { path: string; nodeId: string | null; onGoto: (id: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const note = useIae((st) => st.files.find((f) => f.path === path)?.note);
  const map = useIae((st) => st.map);

  useEffect(() => {
    let alive = true;
    setText(null);
    setFailed(false);
    bridge.explainFile(path).then(
      (t) => alive && setText(t.trim()),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [path]);

  const node = nodeId ? map.nodes[nodeId] : undefined;
  const chain = useMemo(() => (node ? [...ancestorsOf(map, node.id), node] : []), [map, node]);
  const { usedBy, talksTo, via } = useMemo(() => connections(map, nodeId), [map, nodeId]);
  const paragraphs = text && text !== note?.trim() ? text.split(/\n{2,}/) : [];

  const chip = (n: ArchNode, labels: string[] = []) => (
    <button key={n.id} type="button" className={s.chip} onClick={() => onGoto(n.id)} title={n.summary}>
      <NodeMark kind={n.kind} />
      <span>{n.label}</span>
      {labels.length > 0 && <span className={s.edgeLabel}>{labels.join(', ')}</span>}
    </button>
  );

  return (
    <div className={s.scroll}>
      <article className={s.col}>
        {note && <p className={s.lede}>{note}</p>}

        <div className={s.explain} aria-live="polite">
          {text === null && !failed && (
            <motion.p className={s.reading} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25, duration: 0.4 }}>
              Reading…
            </motion.p>
          )}
          {failed && <p className={s.quiet}>Couldn't read this one just now. The code is still here under Code.</p>}
          {paragraphs.map((p, i) => (
            <motion.p key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.32, delay: i * 0.06 }}>
              {p}
            </motion.p>
          ))}
        </div>

        <dl className={s.facts}>
          {chain.length > 0 && (
            <>
              <dt>Lives in</dt>
              <dd className={s.chain}>
                {chain.map((n, i) => (
                  <span key={n.id} className={s.step}>
                    {i > 0 && <span className={s.sep}>/</span>}
                    {chip(n)}
                  </span>
                ))}
              </dd>
            </>
          )}
          {usedBy.length > 0 && (
            <>
              <dt>{via ? `${via.label} is used by` : 'Used by'}</dt>
              <dd>{usedBy.map((l) => chip(l.node, l.labels))}</dd>
            </>
          )}
          {talksTo.length > 0 && (
            <>
              <dt>{via ? `${via.label} talks to` : 'Talks to'}</dt>
              <dd>{talksTo.map((l) => chip(l.node, l.labels))}</dd>
            </>
          )}
          {!nodeId && (
            <>
              <dt>Lives in</dt>
              <dd className={s.quiet}>No part of the map owns this file yet.</dd>
            </>
          )}
        </dl>
      </article>
    </div>
  );
}
