# Demo: IAE in five minutes

This walk-through shows the three things that make IAE different: you talk and
the map follows, no one ever waits, and you know where everything lives.

## Before you start

```bash
npm install
npm run voice:setup     # optional, ~270MB: on-device speech-to-text, works offline
npm run dev
```

You need Claude Code installed and signed in. If `claude` works in a terminal,
IAE works.

For the best voice, download a premium system voice: System Settings →
Accessibility → Spoken Content → System voice → Manage voices → English →
**Ava (Premium)** or **Zoe (Premium)**. IAE picks it up automatically.

## 1. A blank page becomes an architecture (about 2 minutes)

1. On Home, click **New project** and name it `Trail Mix`.
2. Archie greets you. Hold **Space** (or type) and say:
   > "It's an app where a group of friends plans hiking trips together: one
   > organiser proposes trails and dates, everyone votes, and we share a
   > packing list."
3. While you're talking, ghost nodes sketch themselves (that's architecture
   autocomplete). When you finish, Archie answers in a sentence and commits
   the real nodes. A question card appears on the node it's about, with a
   recommended answer first.
4. Click the recommended option, or just say "web app is fine". Archie
   acknowledges it and moves to the next real decision.
5. Say "go ahead and build the trips API". A builder (Ada) appears on the API
   node with a one-line activity and a soft sheen while she works. Archie keeps
   the conversation going while she builds. You're never waiting.
6. When Ada finishes, Archie tells you in one sentence and ties it to what's
   next. The node turns solid, and the files she wrote now live inside it.

## 2. An existing codebase, mapped (about 2 minutes)

1. ⌘K → **Open project…** → choose `examples/recipe-box` (in this repo). Open
   a copy if you don't want `.iae/` written there.
2. A rough map appears instantly. Then Atlas, the cartographer, reads the code,
   and the map sharpens over about a minute into a real architecture: Web, API
   (Auth, Recipes, Search, Uploads, Config), Jobs, Postgres, S3, Resend,
   Google OAuth.
3. Archie says what kind of system it is and asks what you're changing today.
   It often spots real gaps, for example *"Nothing enqueues jobs today. Should
   the API queue thumbnail jobs after uploads?"*
4. **Find your `.env` through the map**: double-click **API**, then **Config**,
   then `.env`. Values are masked, sections and per-key notes come from the
   file's comments, and you edit in place. ⌘S saves and keeps the formatting.
5. Press ⌘M (meaning mode) and the file names turn into what each file is for.

## 3. Still Claude Code

- Type `/` in the intent line to see your Claude Code commands and skills,
  for example `/code-review` or `/security-review`. A command runs as a
  builder on the map.
- Builders load your CLAUDE.md, skills, plugins, hooks and MCP servers.
- ⌘K → Settings sets autonomy: *ask* (approve every change), *edits*
  (default: edits flow, commands ask, approved with ✓ on the map) or *full*.

## Keys worth showing

| Key | |
|---|---|
| hold Space | talk |
| ↵ / double-click | dive into a node |
| Esc | close lens → clear selection → surface |
| ⌘K | everything else |
| ⌘J | transcript |
| ⌘M | meaning mode |
| ⌘0 | fit |
| ⌘. | interrupt Archie |
