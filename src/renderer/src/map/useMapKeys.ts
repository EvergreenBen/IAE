// Map keyboard: Esc (clear selection → surface), ↵ dive, ⌘0 fit, ⌘M meaning,
// arrows move the selection. Never touches Space (push-to-talk) and ignores
// keys while the user is typing.
import { useEffect } from 'react';
import { ui, useIae } from '../state/store';
import type { Driver } from './driver';
import { scopeKey } from './layout';
import { useMapLocal } from './mapStore';

// The intent line keeps focus; while it's empty, map keys pass through it
// (it lets an empty ↵ through to dive into the selection — see IntentLine).
const INTENT_INPUT = 'data-intent-input';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.hasAttribute?.(INTENT_INPUT)) return (el as HTMLInputElement).value !== '';
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest?.('[contenteditable="true"], .cm-editor');
};

export function useMapKeys(driver: Driver | null) {
  useEffect(() => {
    if (!driver) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const st = useIae.getState();
      const mod = e.metaKey || e.ctrlKey;
      // ⌘0 and ⌘M mean nothing to a text field: they work everywhere but the code editor.
      if (mod && (e.target as HTMLElement | null)?.closest?.('.cm-editor')) return;
      if (!mod && typing(e.target)) return;
      if (mod && e.key === '0') {
        e.preventDefault();
        driver.fit();
        return;
      }
      if (mod && (e.key === 'm' || e.key === 'M') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        ui.toggleMeaning();
        return;
      }
      if (mod || e.altKey) return;
      if (st.openFile || st.paletteOpen || st.transcriptOpen) return;

      if (e.key === 'Escape') {
        if (st.selectedNodeId) {
          ui.select(null);
          e.preventDefault();
        } else if (st.scopeId) {
          ui.setScope(st.map.nodes[st.scopeId]?.parentId ?? null);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Enter' && st.selectedNodeId && st.map.nodes[st.selectedNodeId]) {
        e.preventDefault();
        ui.setScope(st.selectedNodeId);
        return;
      }
      if (e.key.startsWith('Arrow')) {
        const ml = useMapLocal.getState();
        if (ml.shown === undefined) return;
        const L = ml.layouts[scopeKey(ml.shown)];
        if (!L || !L.order.length) return;
        e.preventDefault();
        const cur = st.selectedNodeId ? L.nodes[st.selectedNodeId] : undefined;
        if (!cur) return ui.select(L.order[0]);
        const cx = cur.x + cur.w / 2;
        const cy = cur.y + cur.h / 2;
        const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
        if (!dir) return;
        let best: string | null = null;
        let bestScore = Infinity;
        for (const n of Object.values(L.nodes)) {
          if (n.id === cur.id) continue;
          const dx = n.x + n.w / 2 - cx;
          const dy = n.y + n.h / 2 - cy;
          const along = dx * dir[0] + dy * dir[1];
          if (along <= 4) continue;
          const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
          const score = along + across * 2;
          if (score < bestScore) {
            bestScore = score;
            best = n.id;
          }
        }
        if (best) ui.select(best);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [driver]);
}
