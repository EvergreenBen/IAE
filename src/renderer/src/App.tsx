// Top-level composition. There are exactly two places: Home and a Project.
// A project is one full-bleed architecture map with a few quiet layers on top.
// The window starts where the work is: a project still open (the window
// reloaded) or the one that was open when the app last quit, else Home.
import { useEffect } from 'react';
import { bridge } from './bridge';
import { useIae } from './state/store';
import { Home } from './home/Home';
import { MapView } from './map/MapView';
import { ConversationLayer } from './conversation/ConversationLayer';
import { Lens } from './lens/Lens';
import { Palette } from './palette/Palette';
import { speakOptions, tts } from './voice/tts';

export function App() {
  const screen = useIae((s) => s.screen);

  useEffect(() => {
    void bridge.getSettings().then((settings) => {
      useIae.setState({ settings });
      // Archie's voice takes a few seconds to load: start now, before there is anything to say.
      tts.opts = speakOptions(settings.voice);
      tts.prewarm();
    });
    void bridge.getHome().then((h) => useIae.setState({ claude: h.claude, claudeDetail: h.claudeDetail }));
    const home = () => useIae.setState((s) => (s.screen === 'boot' ? { screen: 'home' } : {}));
    bridge.resume().then((snapshot) => !snapshot && home(), home);
  }, []);

  // Only for the moment it takes to ask: the canvas colour, no Home flashing past.
  if (screen === 'boot') return null;
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
