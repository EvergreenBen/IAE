// What a permission pill says. Builders run commands from the project root, so
// they arrive as `cd "/Users/…/project" && npm install fastify`: the part worth
// reading is after the cd. Pure, so it can be tested.

/** Drop leading `cd <dir> &&` / `cd <dir>;` (builders prefix them; they say nothing). */
export function stripCd(cmd: string): string {
  let s = cmd.trim();
  for (let i = 0; i < 4; i++) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(s);
    if (!m || m[0].length >= s.length) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/** Long absolute paths shortened in the middle, keeping the last segment: /Users/…/schema.ts. */
export function shortenPaths(cmd: string, max = 24): string {
  return cmd.replace(/(^|[\s=:("'])((?:~|\.{1,2})?\/[^\s"';&|()]+)/g, (all, pre: string, path: string) => {
    if (path.length <= max) return all;
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 3) return all;
    const head = path.startsWith('/') ? `/${parts[0]}` : parts[0];
    return `${pre}${head}/…/${parts[parts.length - 1]}`;
  });
}

export interface PermText {
  /** "Run", "Edit", or the whole summary when there's nothing to set in mono. */
  verb: string;
  /** The meaningful command or file, in mono. */
  code?: string;
  /** The whole thing, for the tooltip and the expanded pill. */
  full?: string;
}

/** `detail` is the untruncated command when the engine sends it (the summary is clipped). */
export function permissionText(tool: string, summary: string, detail?: string): PermText {
  const sum = summary.trim().replace(/\?$/, '');
  if (/^bash$/i.test(tool)) {
    const whole = (detail?.trim() || sum.replace(/^run\s+/i, '')).trim();
    const full = stripCd(whole);
    const firstLine = full.split('\n')[0];
    return { verb: 'Run', code: shortenPaths(firstLine) || firstLine, full };
  }
  const m = /^(Write|Edit|Read|Fetch)\s+(.+)$/.exec(sum);
  if (m) return { verb: m[1], code: m[2], full: detail?.trim() || m[2] };
  return { verb: sum };
}
