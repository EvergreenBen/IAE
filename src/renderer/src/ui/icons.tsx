// A few hand-drawn line icons: 16px box, 1.5px stroke, currentColor.
// Geometric and quiet, matching the map's node glyphs. No icon fonts.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const EyeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
    <circle cx="8" cy="8" r="1.9" />
  </Svg>
);

export const EyeOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.2 4c.57-.16 1.17-.25 1.8-.25 4 0 6.25 4.25 6.25 4.25a11 11 0 0 1-1.6 2.15M9.9 11.95c-.6.19-1.23.3-1.9.3-4 0-6.25-4.25-6.25-4.25A11.2 11.2 0 0 1 4 5.2" />
    <path d="M2.5 2.5l11 11" />
  </Svg>
);

export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Svg>
);

export const MinusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3.25 8h9.5" />
  </Svg>
);

export const BackIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9.75 3.5L5.25 8l4.5 4.5" />
  </Svg>
);

export const FileIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
  </Svg>
);

export const FolderIcon = (p: P) => (
  <Svg {...p}>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </Svg>
);

export const SlashIcon = (p: P) => (
  <Svg {...p}>
    <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3" />
    <path d="M9.6 4.75L6.4 11.25" />
  </Svg>
);

export const SettingsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.25 4.75h6.5M11.75 4.75h2M2.25 11.25h2M7.25 11.25h6.5" />
    <circle cx="10.25" cy="4.75" r="1.5" />
    <circle cx="5.75" cy="11.25" r="1.5" />
  </Svg>
);

export const ToggleIcon = ({ on, ...p }: P & { on: boolean }) => (
  <Svg {...p}>
    <rect x="1.75" y="4.25" width="12.5" height="7.5" rx="3.75" />
    <circle cx={on ? 10.5 : 5.5} cy="8" r="1.9" fill={on ? 'currentColor' : 'none'} />
  </Svg>
);

export const ArrowIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h9.5M8.75 4.25L12.5 8l-3.75 3.75" />
  </Svg>
);

export const NodeIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3.5" width="12" height="9" rx="2.5" />
  </Svg>
);

export const SendIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 12.75V3.5M4 7.25L8 3.25l4 4" />
  </Svg>
);

export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.25h10M3 8h10M3 11.75h6" />
  </Svg>
);

export const SpeakerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6.25h2.25L8 3.5v9L4.75 9.75H2.5z" />
    <path d="M10.5 5.75a3 3 0 0 1 0 4.5M12.25 4a5.5 5.5 0 0 1 0 8" />
  </Svg>
);

export const MicIcon = (p: P) => (
  <Svg {...p}>
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
    <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2" />
  </Svg>
);

export const TranscriptIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.75 3.25h7M2.75 6.5h10.5M2.75 9.75h10.5M2.75 13h6" />
  </Svg>
);

export const ExitIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 2.75H3.25v10.5H6.5M10 5l3 3-3 3M13 8H6.5" />
  </Svg>
);

export const ChatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M2.25 7.5c0-2.75 2.5-4.75 5.75-4.75s5.75 2 5.75 4.75-2.5 4.75-5.75 4.75c-.8 0-1.55-.12-2.25-.33L3 13.25l.65-2.5A4.4 4.4 0 0 1 2.25 7.5z" />
  </Svg>
);

export const MeaningIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4" />
    <path d="M8 4.75h.01" strokeWidth={2} />
  </Svg>
);
