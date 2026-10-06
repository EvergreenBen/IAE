// Hand-drawn line glyphs. One geometric family: 16px grid, 1.5px stroke, round
// caps and joins, no fills. Exported for reuse (lens, palette, chips).
import type { NodeKind } from '@shared/model';
import type { ReactNode } from 'react';

const KIND_PATHS: Record<NodeKind, ReactNode> = {
  // A grouping of parts.
  system: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1.4" />
    </>
  ),
  // A window people look at.
  client: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
      <path d="M1.75 6.25h12.5" />
    </>
  ),
  // Something running: a ring around a core.
  service: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  // A code component: a small block.
  module: (
    <>
      <path d="M8 1.9 13.6 5.1v5.8L8 14.1 2.4 10.9V5.1z" />
      <path d="M2.6 5.2 8 8.3l5.4-3.1M8 8.3v5.6" />
    </>
  ),
  // A store: the cylinder.
  data: (
    <>
      <ellipse cx="8" cy="4" rx="5.25" ry="2.1" />
      <path d="M2.75 4v8c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1V4" />
      <path d="M2.75 8c0 1.16 2.35 2.1 5.25 2.1s5.25-.94 5.25-2.1" />
    </>
  ),
  // Work flowing through.
  queue: (
    <>
      <path d="M2 4.5h7.5M2 8h7.5M2 11.5h7.5" />
      <path d="m11.75 5.5 2.5 2.5-2.5 2.5" />
    </>
  ),
  // Somewhere else: an arrow leaving the box.
  external: (
    <>
      <path d="M9.5 2.25h4.25V6.5M13.6 2.4 7.75 8.25" />
      <path d="M12.25 9.75v2.5a1.75 1.75 0 0 1-1.75 1.75H4a1.75 1.75 0 0 1-1.75-1.75V5.5A1.75 1.75 0 0 1 4 3.75h2.5" />
    </>
  ),
  // Knobs you set.
  config: (
    <>
      <path d="M2 5h5.25M10.75 5H14M2 11h2.25M7.75 11H14" />
      <circle cx="9" cy="5" r="1.75" />
      <circle cx="6" cy="11" r="1.75" />
    </>
  ),
  // Where it runs: a rack.
  infra: (
    <>
      <rect x="2" y="2.25" width="12" height="5" rx="1.5" />
      <rect x="2" y="8.75" width="12" height="5" rx="1.5" />
      <path d="M4.75 4.75h.01M4.75 11.25h.01" />
    </>
  ),
  // A model: the four-point spark.
  ai: <path d="M8 1.75C8.55 5.35 10.65 7.45 14.25 8 10.65 8.55 8.55 10.65 8 14.25 7.45 10.65 5.35 8.55 1.75 8 5.35 7.45 7.45 5.35 8 1.75Z" />,
};

export function KindGlyph({ kind, size = 16, className, tint }: { kind: NodeKind; size?: number; className?: string; tint?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ color: tint ?? `var(--kind-${kind})`, flex: 'none' }}
    >
      {KIND_PATHS[kind] ?? KIND_PATHS.module}
    </svg>
  );
}

// ── Files ────────────────────────────────────────────────────────────────────

export type FileKind = 'code' | 'env' | 'doc' | 'data' | 'style' | 'image' | 'json' | 'other';

export function fileKind(path: string): FileKind {
  const name = path.split('/').pop() ?? path;
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'env';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'cs', 'php', 'vue', 'svelte'].includes(ext)) return 'code';
  if (['md', 'mdx', 'txt', 'rst'].includes(ext)) return 'doc';
  if (['sql', 'prisma', 'db', 'sqlite', 'csv'].includes(ext)) return 'data';
  if (['css', 'scss', 'less', 'sass'].includes(ext)) return 'style';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'].includes(ext)) return 'image';
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'lock'].includes(ext)) return 'json';
  return 'other';
}

const FILE_MARKS: Record<FileKind, ReactNode> = {
  code: <path d="M6.1 7.4 4.6 8.9l1.5 1.5M8.9 7.4l1.5 1.5-1.5 1.5" />,
  env: (
    <>
      <circle cx="5.9" cy="9.4" r="1.35" />
      <path d="M7.25 9.4h3.1M9.3 9.4v1.2" />
    </>
  ),
  doc: <path d="M4.9 7.6h5.2M4.9 9.6h5.2M4.9 11.6h3.2" />,
  data: (
    <>
      <ellipse cx="7.5" cy="7.9" rx="2.5" ry=".95" />
      <path d="M5 7.9v3c0 .52 1.12.95 2.5.95s2.5-.43 2.5-.95v-3" />
    </>
  ),
  style: <path d="M6.3 7.2 5.7 11.6M9.3 7.2l-.6 4.4M4.8 8.6h5.6M4.6 10.2h5.6" />,
  image: (
    <>
      <path d="m4.6 11.6 2-2.3 1.4 1.4 1-1 1.6 1.9" />
      <circle cx="9.3" cy="7.6" r=".7" />
    </>
  ),
  json: <path d="M6.2 7.1c-.8 0-1 .4-1 1v.5c0 .4-.3.7-.7.7.4 0 .7.3.7.7v.5c0 .6.2 1 1 1M8.8 7.1c.8 0 1 .4 1 1v.5c0 .4.3.7.7.7-.4 0-.7.3-.7.7v.5c0 .6-.2 1-1 1" />,
  other: <path d="M4.9 8.6h5.2M4.9 10.6h3.6" />,
};

export function FileGlyph({ path, size = 14, className }: { path: string; size?: number; className?: string }) {
  const k = fileKind(path);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: 'none' }}
    >
      <path d="M3.6 1.6h4.9l3 3v8.1c0 .44-.36.8-.8.8H3.6a.8.8 0 0 1-.8-.8V2.4c0-.44.36-.8.8-.8Z" />
      <path d="M8.4 1.7v2.4c0 .3.2.5.5.5h2.5" />
      {FILE_MARKS[k]}
    </svg>
  );
}

/** Small marks used around the map (stubs, warnings, check/cross). */
export function Mark({ name, size = 12 }: { name: 'check' | 'cross' | 'arrow' | 'alert' | 'files'; size?: number }) {
  const body: Record<typeof name, ReactNode> = {
    check: <path d="m3.2 8.3 2.9 2.9 6.7-6.7" />,
    cross: <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />,
    arrow: <path d="M2.5 8h10.5M9.5 4.5 13 8l-3.5 3.5" />,
    alert: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.9v3.6M8 11h.01" />
      </>
    ),
    files: (
      <>
        <path d="M4.5 2.5h4.5l2.5 2.5v8a.5.5 0 0 1-.5.5h-6.5a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5Z" />
        <path d="M9 2.6v2.4h2.4" />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: 'none' }}>
      {body[name]}
    </svg>
  );
}
