// A quiet find bar for the lens: one field, a match count, previous / next.
// Replaces CodeMirror's default panel (regexp, by-word, replace-all…), which
// reads like an IDE. Esc is handled by the lens's escape layer.
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, SearchQuery, setSearchQuery } from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

const ICON = {
  up: '<path d="M4 10l4-4 4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
};

function button(name: keyof typeof ICON, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cm-iae-find-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

const MAX_COUNT = 999;

export function findPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-iae-find';

  const input = document.createElement('input');
  input.className = 'cm-iae-find-input';
  input.placeholder = 'Find in this file';
  input.spellcheck = false;
  input.setAttribute('main-field', 'true');
  input.setAttribute('aria-label', 'Find in this file');
  input.value = getSearchQuery(view.state).search;

  const count = document.createElement('span');
  count.className = 'cm-iae-find-count';
  count.setAttribute('aria-live', 'polite');

  const commit = () => {
    const q = new SearchQuery({ search: input.value });
    if (!q.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(q) });
  };

  const refresh = () => {
    const q = getSearchQuery(view.state);
    if (!q.search || !q.valid) {
      count.textContent = '';
      return;
    }
    const sel = view.state.selection.main;
    const cursor = q.getCursor(view.state);
    let total = 0;
    let current = 0;
    for (let r = cursor.next(); !r.done && total < MAX_COUNT; r = cursor.next()) {
      total++;
      if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    }
    count.textContent = total === 0 ? 'No matches' : current ? `${current} of ${total}` : total === 1 ? '1 match' : `${total} matches`;
    dom.classList.toggle('cm-iae-find-none', total === 0);
  };

  input.addEventListener('input', () => {
    commit();
    refresh();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      (e.shiftKey ? findPrevious : findNext)(view);
    }
  });

  dom.append(
    input,
    count,
    button('up', 'Previous match (⇧↵)', () => {
      commit();
      findPrevious(view);
    }),
    button('down', 'Next match (↵)', () => {
      commit();
      findNext(view);
    }),
    button('close', 'Close (Esc)', () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );

  return {
    dom,
    top: false,
    mount() {
      input.select();
      refresh();
    },
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((ef) => ef.is(setSearchQuery)))) {
        const q = getSearchQuery(u.state).search;
        if (q !== input.value && document.activeElement !== input) input.value = q;
        refresh();
      }
    },
  };
}
