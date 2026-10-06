// Top-level composition. There are exactly two places: Home and a Project.
// A project is one full-bleed architecture map with a few quiet layers on top.
import { useEffect } from 'react';
import { bridge } from './bridge';
import { useIae } from './state/store';
import { Home } from './home/Home';
import { MapView } from './map/MapView';
import { ConversationLayer } from './conversation/ConversationLayer';
import { Lens } from './lens/Lens';
import { Palette } from './palette/Palette';

export function App() {
  const screen = useIae((s) => s.screen);

  useEffect(() => {
    void bridge.getSettings().then((settings) => useIae.setState({ settings }));
    void bridge.getHome().then((h) => useIae.setState({ claude: h.claude, claudeDetail: h.claudeDetail }));
  }, []);

  if (screen === 'home') return <Home />;

  return (
    <>
      <MapView />
      <ConversationLayer />
      <Lens />
      <Palette />
    </>
  );
}
