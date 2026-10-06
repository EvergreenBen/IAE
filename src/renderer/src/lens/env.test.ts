import { describe, expect, it } from 'vitest';
import { addEntry, duplicateKeys, entriesOf, formatValue, headingText, insertItem, normalizeKey, parseEnv, removeItem, serializeEnv, updateEntry } from './env';

const SAMPLE = `# ── Recipe Box API ──

# Postgres, used by Drizzle and the session store
DATABASE_URL=postgres://recipe:recipe@localhost:5432/recipebox
export NODE_ENV=development
GOOGLE_CLIENT_SECRET="s3cr3t value"   # rotate quarterly
SINGLE='it''s'
EMPTY=
SPACED = padded
URL_WITH_HASH=http://x.dev/#frag
PRIVATE_KEY="-----BEGIN-----
abc
-----END-----"
not a valid line
# trailing comment
`;

describe('env round trip', () => {
  it('returns the input unchanged when nothing is edited', () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE);
  });

  it.each([
    ['empty', ''],
    ['one newline', '\n'],
    ['no trailing newline', 'A=1\nB=2'],
    ['crlf', 'A=1\r\n# note\r\nB="x y"\r\n'],
    ['only comments', '# a\n# b\n'],
    ['blank lines', '\n\nA=1\n\n\n'],
    ['unterminated quote', 'A="oops\nB=2\n'],
  ])('round-trips %s', (_, text) => {
    expect(serializeEnv(parseEnv(text))).toBe(text);
  });

  it('reads keys, values, notes and inline comments', () => {
    const doc = parseEnv(SAMPLE);
    const byKey = Object.fromEntries(entriesOf(doc).map((e) => [e.key, e]));
    expect(byKey.DATABASE_URL.value).toBe('postgres://recipe:recipe@localhost:5432/recipebox');
    expect(byKey.DATABASE_URL.note).toBe('Postgres, used by Drizzle and the session store');
    expect(byKey.NODE_ENV.exported).toBe(true);
    expect(byKey.GOOGLE_CLIENT_SECRET.value).toBe('s3cr3t value');
    expect(byKey.GOOGLE_CLIENT_SECRET.quote).toBe('"');
    expect(byKey.GOOGLE_CLIENT_SECRET.inline).toBe('   # rotate quarterly');
    expect(byKey.EMPTY.value).toBe('');
    expect(byKey.SPACED.value).toBe('padded');
    expect(byKey.URL_WITH_HASH.value).toBe('http://x.dev/#frag');
    expect(byKey.PRIVATE_KEY.value).toBe('-----BEGIN-----\nabc\n-----END-----');
    // The header comment is separated by a blank line, so it stands alone.
    expect(doc.items[0]).toMatchObject({ kind: 'comment' });
    expect(headingText((doc.items[0] as { text: string }).text)).toBe('Recipe Box API');
  });
});

describe('env headings', () => {
  it('treats ruled comments as headings even directly above an entry', () => {
    const text = '# ── Google sign-in ──\nGOOGLE_CLIENT_ID=x\n# Where people land\nREDIRECT=y\n';
    const doc = parseEnv(text);
    expect(doc.items[0]).toMatchObject({ kind: 'comment', text: '── Google sign-in ──' });
    const [id, redirect] = entriesOf(doc);
    expect(id.note).toBeNull();
    expect(redirect.note).toBe('Where people land');
    expect(serializeEnv(doc)).toBe(text);
  });
});

describe('env file header', () => {
  it('keeps a comment block above a blank line out of the first key', () => {
    const text = '# Recipe Box, local dev\n# Copy to .env.local\n\nDATABASE_URL=x\nREDIS_URL=y\n';
    const doc = parseEnv(text);
    expect(entriesOf(doc)[0].note).toBeNull();
    expect(doc.items.slice(0, 2)).toMatchObject([
      { kind: 'comment', text: 'Recipe Box, local dev' },
      { kind: 'comment', text: 'Copy to .env.local' },
    ]);
    expect(serializeEnv(doc)).toBe(text);
  });

  it("reads the file's opening comment over a run of keys as a header, not a note", () => {
    const text = '# FAKE demo values - not real credentials\nDATABASE_URL=postgres://x\nGOOGLE_CLIENT_ID=y\n# Where people land\nREDIRECT=z\n';
    const doc = parseEnv(text);
    const [db, google, redirect] = entriesOf(doc);
    expect(doc.items[0]).toMatchObject({ kind: 'comment', text: 'FAKE demo values - not real credentials' });
    expect(db.note).toBeNull();
    expect(google.note).toBeNull();
    expect(redirect.note).toBe('Where people land');
    expect(serializeEnv(doc)).toBe(text);
    // Editing a value next to the header leaves the header where it was.
    expect(serializeEnv(updateEntry(doc, db.id, { value: 'postgres://y' }))).toBe(text.replace('postgres://x', 'postgres://y'));
  });

  it('still reads a top comment over a lone key as its note', () => {
    const text = '# Postgres for local dev\nDATABASE_URL=x\n\n# Redis\nREDIS_URL=y\n';
    const doc = parseEnv(text);
    expect(entriesOf(doc).map((e) => e.note)).toEqual(['Postgres for local dev', 'Redis']);
    expect(serializeEnv(doc)).toBe(text);
  });

  it('round-trips a CRLF file with a header', () => {
    const text = '# header\r\nA=1\r\nB=2\r\n';
    expect(serializeEnv(parseEnv(text))).toBe(text);
  });
});

describe('env edits', () => {
  it('changes only the edited line', () => {
    const doc = parseEnv(SAMPLE);
    const secret = entriesOf(doc).find((e) => e.key === 'GOOGLE_CLIENT_SECRET')!;
    const out = serializeEnv(updateEntry(doc, secret.id, { value: 'new one' }));
    expect(out).toBe(SAMPLE.replace('GOOGLE_CLIENT_SECRET="s3cr3t value"   # rotate quarterly', 'GOOGLE_CLIENT_SECRET="new one"   # rotate quarterly'));
  });

  it('restores the original text when a value is changed back', () => {
    const doc = parseEnv(SAMPLE);
    const e = entriesOf(doc).find((x) => x.key === 'SPACED')!;
    const changed = updateEntry(doc, e.id, { value: 'x' });
    const back = updateEntry(changed, e.id, { value: 'padded' });
    expect(serializeEnv(back)).toBe(SAMPLE);
  });

  it('adds an entry before trailing blank lines and quotes when needed', () => {
    const { doc } = addEntry(parseEnv('A=1\n\n'), 'STRIPE_KEY', 'sk test');
    expect(serializeEnv(doc)).toBe('A=1\nSTRIPE_KEY="sk test"\n\n');
  });

  it('adds to an empty file with a trailing newline', () => {
    const { doc } = addEntry(parseEnv(''), 'A', '1');
    expect(serializeEnv(doc)).toBe('A=1\n');
  });

  it('removes and re-inserts an entry with its note', () => {
    const doc = parseEnv(SAMPLE);
    const db = entriesOf(doc).find((e) => e.key === 'DATABASE_URL')!;
    const { doc: without, removed, index } = removeItem(doc, db.id);
    expect(serializeEnv(without)).not.toContain('DATABASE_URL');
    expect(serializeEnv(without)).not.toContain('Postgres, used by Drizzle');
    expect(serializeEnv(insertItem(without, removed!, index))).toBe(SAMPLE);
  });

  it('rewrites the note as comment lines when edited', () => {
    const doc = parseEnv('# old\nA=1\n');
    const a = entriesOf(doc)[0];
    expect(serializeEnv(updateEntry(doc, a.id, { note: 'new note' }))).toBe('# new note\nA=1\n');
    expect(serializeEnv(updateEntry(doc, a.id, { note: '' }))).toBe('A=1\n');
  });

  it('formats values minimally', () => {
    expect(formatValue('plain', '')).toBe('plain');
    expect(formatValue('has space', '')).toBe('"has space"');
    expect(formatValue('say "hi"', '')).toBe(`'say "hi"'`);
    expect(formatValue('kept', "'")).toBe("'kept'");
  });

  it('flags duplicate keys and normalizes typed keys', () => {
    expect([...duplicateKeys(parseEnv('A=1\nB=2\nA=3\n'))]).toEqual(['A']);
    expect(normalizeKey('stripe secret-key')).toBe('STRIPE_SECRET_KEY');
    expect(normalizeKey('9lives!')).toBe('LIVES');
  });
});
