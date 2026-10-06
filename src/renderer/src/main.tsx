import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { bridge, wireBridge } from './bridge';
import { applyEvent, ui, useIae } from './state/store';

wireBridge();

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
