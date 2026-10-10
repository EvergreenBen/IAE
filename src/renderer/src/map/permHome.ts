// Where a builder's permission prompt shows. On the map it hangs off the
// builder's token, but only while that token is on screen (clear of the chrome
// and the conversation); otherwise, or when another builder on the same node
// already shows one there, it hangs off the builder's row in the crew panel.
import { useEffect, useMemo, useState } from 'react';
import type { AgentInfo } from '@shared/model';
import { useIae, type PermissionRequest } from '../state/store';
import { useAnchorFn, useShownLayout, type Anchor } from './anchors';
import { CONVERSATION_ZONE, SAFE } from './camera';
import { useCamera } from './context';
import { clamp, type Pt } from './geometry';

/** Agents on the map, grouped by the node they show on, in token order (Crew.tsx). */
export function tokensByAnchor(agents: AgentInfo[], anchorOf: (nodeId: string | null | undefined) => Anchor | null): Map<string, { at: Anchor; list: AgentInfo[] }> {
  const out = new Map<string, { at: Anchor; list: AgentInfo[] }>();
  for (const a of agents) {
    if (a.role === 'lead' || !a.nodeId) continue;
    const at = anchorOf(a.nodeId);
    if (!at) continue;
    const cur = out.get(at.id) ?? { at, list: [] };
    cur.list.push(a);
    out.set(at.id, cur);
  }
  for (const v of out.values()) v.list.sort((x, y) => x.startedAt - y.startedAt);
  return out;
}

/** Centre of a token (world px): docked at the anchor's top-right, side by side, counter-scaled by `ov`. */
export function tokenPoint(at: Anchor, index: number, ov: number): Pt {
  return { x: at.rect.x + at.rect.w - (at.frame ? 30 : 18) - index * 24 * ov, y: at.rect.y + (at.frame ? 36 : 0) };
}

/** Agent ids whose pending prompt shows on their map token (the rest show in the chrome). */
export function permsOnMap(
  agents: AgentInfo[],
  permissions: PermissionRequest[],
  anchorOf: (nodeId: string | null | undefined) => Anchor | null,
  inView: (p: Pt) => boolean,
  ov: number,
): Set<string> {
  const out = new Set<string>();
  const asking = new Set(permissions.map((p) => p.agentId));
  for (const { at, list } of tokensByAnchor(agents, anchorOf).values()) {
    // One prompt per node on the map: two would stack over each other's tokens.
    const i = list.findIndex((a) => asking.has(a.id));
    if (i === -1) continue;
    if (inView(tokenPoint(at, i, ov))) out.add(list[i].id);
  }
  return out;
}

/** Live version of permsOnMap for the shown scope, re-checked whenever the camera comes to rest. */
export function usePermsOnMap(): Set<string> {
  const agents = useIae((s) => s.agents);
  const permissions = useIae((s) => s.permissions);
  const anchor = useAnchorFn();
  const { busy } = useShownLayout();
  const cam = useCamera();
  const [tick, setTick] = useState(0);
  useEffect(() => cam?.onSettle(() => setTick((n) => n + 1)), [cam]);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return useMemo(() => {
    if (busy || !permissions.length) return new Set<string>();
    const k = cam?.view.k ?? 1;
    const ov = clamp(k, 0.8, 1.2) / k;
    const inView = (p: Pt) => {
      if (!cam) return true;
      const s = cam.toScreen({ x: p.x, y: p.y, w: 0, h: 0 });
      const { w, h } = cam.size();
      return s.x >= SAFE.side && s.x <= w - SAFE.side && s.y >= SAFE.top && s.y <= h - CONVERSATION_ZONE;
    };
    return permsOnMap(Object.values(agents), permissions, anchor, inView, ov);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, permissions, anchor, busy, cam, tick]);
}
