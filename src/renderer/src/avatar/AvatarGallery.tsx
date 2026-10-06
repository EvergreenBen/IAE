// Dev-only: every Archie expression and crew state on one sheet, for design
// review. Not imported by the app. In the browser dev server:
//   await import('/src/avatar/AvatarGallery.tsx').then((m) => m.mountAvatarGallery())

import { createRoot } from 'react-dom/client';
import '../styles/global.css';
import { useEffect, useState } from 'react';
import { speechPulse } from '../voice/pulse';
import { Archie, type ArchieState } from './Archie';
import { CrewMark, type CrewMarkProps } from './CrewMark';

const STATES: ArchieState[] = ['idle', 'listening', 'thinking', 'speaking', 'question', 'away'];
const CREW: NonNullable<CrewMarkProps['state']>[] = ['starting', 'thinking', 'working', 'waiting', 'done', 'failed', 'stopped'];
const NAMES = ['Ada', 'Kit', 'Rho', 'Juno', 'Max', 'Bea'];

const cell: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, width: 124 };
const caption: React.CSSProperties = { font: '12px var(--font-ui)', color: 'var(--ink-3)' };

function Gallery() {
  const [level, setLevel] = useState(0.6);
  useEffect(() => {
    const t = setInterval(() => {
      speechPulse(0.6 + Math.random() * 0.4);
      setLevel(0.3 + Math.random() * 0.7);
    }, 220);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'var(--paper)', padding: 40, display: 'flex', flexDirection: 'column', gap: 36 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {STATES.map((s) => (
          <div key={s} style={cell}>
            <Archie size={96} state={s} level={level} lookAt={{ x: 0, y: 0 }} />
            <span style={caption}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {STATES.map((s) => (
          <div key={s} style={cell}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                height: 52,
                width: 120,
                padding: '0 6px',
                background: 'var(--paper-raised)',
                border: '1px solid var(--line)',
                borderRadius: 999,
                boxShadow: 'var(--shadow-2)',
              }}
            >
              <Archie size={40} state={s} level={level} />
              <span style={{ ...caption, color: 'var(--ink-4)' }}>Ask…</span>
            </div>
          </div>
        ))}
      </div>
      {[22, 18, 14].map((size) => (
        <div key={size} style={{ display: 'flex', gap: 8 }}>
          {CREW.map((st, i) => (
            <div key={st} style={cell}>
              <div style={{ display: 'flex', gap: 8 }}>
                {[0, 1, 2].map((h) => (
                  <CrewMark key={h} hue={(i + h) % 6} name={NAMES[(i + h) % 6]} size={size} state={st} />
                ))}
              </div>
              {size === 22 && <span style={caption}>{st}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function mountAvatarGallery(): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  createRoot(el).render(<Gallery />);
}
