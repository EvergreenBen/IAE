// The question card currently on the map, for the conversation layer to tie a
// spoken answer to. Stored as an additive field on the main store
// (`activeAgendaId`) without changing store.ts: read it with
// `useActiveAgendaId()` or `getActiveAgendaId()`.
import { useIae, type IaeState } from '../state/store';

type WithActive = IaeState & { activeAgendaId?: string | null };

export function setActiveAgendaId(id: string | null) {
  // Compare the raw field: undefined ("map hasn't said") and null ("no card up") differ.
  if ((useIae.getState() as WithActive).activeAgendaId !== id) useIae.setState({ activeAgendaId: id } as unknown as Partial<IaeState>);
}

export function getActiveAgendaId(): string | null {
  return (useIae.getState() as WithActive).activeAgendaId ?? null;
}

export const selectActiveAgendaId = (s: IaeState) => (s as WithActive).activeAgendaId ?? null;

export function useActiveAgendaId(): string | null {
  return useIae(selectActiveAgendaId);
}
