import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { bridge, wireBridge } from './bridge';
import { applyEvent, ui, useIae } from './state/store';
import { reloadWhenQuiet } from './devReload';

wireBridge();

// Dev: a reload that a builder's edit forces waits until nobody is talking (scripts/vite-quiet-reload.ts).
if (import.meta.hot) import.meta.hot.on('arxitect:reload', () => reloadWhenQuiet());

// Dev/audit handle: window.__iae.{useIae, ui, bridge, applyEvent}. URL params drive the
// mock in browser mode: ?open=sample opens the sample project, ?new=Name
// creates an empty one.
(window as unknown as { __iae: unknown }).__iae = { useIae, ui, bridge, applyEvent };
if (bridge.runtime === 'mock') {
  const qs = new URLSearchParams(location.search);
  if (qs.get('open')) void bridge.openProject('/Users/you/Projects/recipe-box');
  else if (qs.get('new')) void bridge.createProject(qs.get('new')!);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
