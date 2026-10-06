// Soft wrap in the lens: prose (markdown, text, READMEs) wraps by default and
// code keeps its lines. Flipping it is remembered per kind of file, for this
// browser profile only; storage can be missing, so every access is guarded.

const KEY = { prose: 'iae.lens.wrap.prose', code: 'iae.lens.wrap.code' } as const;

export function wrapFor(prose: boolean): boolean {
  try {
    const v = localStorage.getItem(prose ? KEY.prose : KEY.code);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* no storage: use the default */
  }
  return prose;
}

export function rememberWrap(prose: boolean, on: boolean): void {
  try {
    const key = prose ? KEY.prose : KEY.code;
    // Back at the default: forget, so a later change of default applies.
    if (on === prose) localStorage.removeItem(key);
    else localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* no storage: this lens only */
  }
}
