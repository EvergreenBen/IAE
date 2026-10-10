# Arxitect architecture

This document describes Arxitect's own architecture. It is also the map Arxitect should
draw of itself.

```
┌──────────────────────────── Electron main (Node 24) ────────────────────────────┐
│                                                                                  │
│  Engine (implements IaeApi) ── emits EngineEvent ──▶ ipc.ts ──▶ renderer         │
│   ├─ ProjectStore     .iae/ persistence, recent projects                         │
│   ├─ FileIndex        scan (gitignore-aware) + chokidar watch → files/replace    │
│   ├─ Heuristic map    instant first map from folders & manifests                 │
│   ├─ Lead             warm Agent SDK session (Opus 5.5, effort low), streaming   │
│   │    └─ iae MCP     sketch_map · focus · ask · resolve_question · decide ·     │
│   │                   delegate · message_agent · stop_agent                      │
│   ├─ Crew             builder/scout sessions (full Claude Code), permissions     │
│   │    └─ iae MCP     map_update · ask_architect                                 │
│   ├─ Cartographer     read-only session that draws the map of an existing repo   │
│   ├─ Sketcher         warm Haiku session: draft text → ghost proposals           │
│   ├─ Agenda           open questions, decisions, blocking waiters                │
│   └─ Pulse            never-idle heartbeat: nudges the lead when it's worth it   │
│                                                                                  │
└───────────────────────────────▲──────────────────────────────────────────────────┘
                                │ window.iae (preload, contextIsolation)
┌───────────────────────────────┴───────── renderer (React 19) ───────────────────┐
│  store.ts (zustand) ◀── reduce(EngineEvent)                                      │
│  map/  camera · ELK layout · nodes · edges · files · agents · ghosts · questions │
│  conversation/  intent line · caption · transcript · lexicon autocomplete        │
│  voice/  STT worker (Whisper) · TTS worker (Kokoro) · VAD · WebGPU/wasm          │
│  avatar/  Archie + crew tokens                                                   │
│  lens/  CodeMirror file view · changes (git diff) · .env editor · meaning        │
│  home/ · palette/                                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Process boundary

- **Renderer → main**: `IaeApi` in `src/shared/bridge.ts`. The preload script
  turns every method in `BRIDGE_METHODS` into `ipcRenderer.invoke('iae:invoke',
  method, args)`, and `src/main/ipc.ts` dispatches to the `Engine` instance.
  Don't write per-method IPC handlers.
- **Main → renderer**: `EngineEvent` in `src/shared/events.ts`, sent on
  `iae:event`. The renderer folds events in exactly one place, `reduce()` in
  `src/renderer/src/state/store.ts`.
- **Browser dev**: `src/renderer/src/bridge/mock.ts` implements the same
  `IaeBridge` and simulates a live session.

## Engine

The Engine stays testable in plain Node. Everything Electron-specific (dialogs,
`app.getPath`, `shell`) goes through a small `EngineHost` interface passed to
its constructor by `src/main/index.ts`.

### Lead

- One long-lived `query()` per open project with **streaming input** (an async
  queue of `SDKUserMessage`) and `includePartialMessages: true`. Text deltas
  become `lead/delta`. The final text becomes `lead/done`.
- Lean by design (`lead-options.ts`). With these options the median time to
  the first spoken word is about 1.1s (p90 about 2.6s):
  `tools: ['Read','Glob','Grep']`, `strictMcpConfig: true`,
  `settingSources: []`, custom `systemPrompt`, `mcpServers: { iae }`,
  `allowedTools: [all iae tools + Read/Glob/Grep]`, `model:
  settings.leadModel`, `effort: settings.leadEffort`, `cwd: project root`.
  Without `strictMcpConfig`, Claude Code pulls in every connector the user has,
  which adds about 100k tokens and 3+ seconds per turn. At effort `low`,
  thinking is turned off: thinking happens before the first word, so it's
  waiting time. A/B: p90 3.1s → 2.2s and −28% cost with the same answers.
  `IAE_LEAD_THINKING=adaptive` turns it back on.
- **Per-turn context**: each user message is wrapped in a compact `<context>`
  block. It holds what the user is looking at (scope, selection, open file),
  the crew's status (and whether builder slots are full), open agenda items
  (marking the card on screen), events since the last turn (builds finished,
  files created), and one-time notes such as a rename. The full map tree
  (`describeMap`) and recorded decisions go only on a session's first turn.
  After that the lead sees just the changes others made (`mapdiff.ts`), which
  keeps the history small and turns fast. The utterance itself goes in a
  `<user_said>` block. When the renderer thinks the utterance answers the card
  on screen, it carries that card's id only as a hint, and the lead decides
  with `resolve_question`.
- **Silence**: if the reply is empty or contains `<silence/>`, `lead/done` is
  emitted with empty text and nothing is spoken.
- **Interrupt**: `interrupt()` calls `query.interrupt()` and drops queued TTS.
  The next user message is sent right away.
- **Resume**: the session id is stored in `.iae/state.json` and passed as
  `resume` when the project reopens, so the lead remembers the project.

### Crew (builders and scouts)

- Each job is its own `query()` with the **full Claude Code experience**:
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: builderBrief }`,
  `settingSources: ['user','project','local']` (skills, CLAUDE.md, plugins,
  hooks, MCP), `model: settings.builderModel`, and `cwd: project root`.
- Permissions follow `settings.autonomy`. `edits` (the default) uses
  `permissionMode: 'acceptEdits'`, and anything else goes to `canUseTool` →
  `permission/request` → the user's ✓/✕ on the map. `full` uses
  `bypassPermissions`. `ask` uses `default`, with `canUseTool` for every write.
- **Shell gate** (`gate.ts`): many people allow `Bash(*)` in
  `~/.claude/settings.json`, which would mean Claude Code never asks. A
  `PreToolUse` hook runs before those rules and sends every shell command that
  isn't plainly read-only (or, in `ask` mode, every write) to the ✓/✕ on the
  map. Read-only commands such as `ls`, `git status`/`diff`/`log` and the
  project's own test, typecheck or build scripts pass through. Builders are
  also told never to launch GUI apps, daemons, Docker, `sudo` or global
  installs.
- The message stream becomes the visualisation. Each `tool_use` block becomes an
  `agent/step`, `files/touched` (for Read/Edit/Write/MultiEdit/NotebookEdit
  paths) and an `agent/upsert` carrying `activity` ("Editing session.ts"),
  `file` and `nodeId` (`ownerOf(map, path)`, keeping the previous node when
  it's unowned).
- **What a builder changed** (`changes.ts`): each Edit, MultiEdit, Write or
  NotebookEdit `tool_use` is held by its id until its `tool_result` comes back.
  An error counts nothing. Otherwise the lines added and removed come from
  Claude Code's own `structuredPatch` on the result (`tool_use_result`), or,
  failing that, from the call itself: `old_string` → `new_string` (a bounded
  Myers line diff, times the occurrences for `replace_all`), or for a Write
  over an existing file, the file as it was when the call arrived. Totals per
  file ride on `AgentInfo.changes` (newest first, at most 100), so they travel
  with `agent/upsert` and the snapshot, survive a window reload, and are saved
  with the job, so a resumed builder keeps counting. A finished job that
  changed files stays on the crew list for review (up to four, oldest first)
  until `clearAgent`. The crew list shows them, and the lens asks `diffFile(path)` for
  the real thing: `git/diffFile` runs `git diff --no-color --no-ext-diff -U3
  HEAD -- <path>` with `execFile` in the project root (never a shell), with
  literal pathspecs, no optional locks and paths kept inside the project
  (`resolveInside`), and parses it into hunks (`parseUnifiedDiff`, pure). An
  untracked file, or a repository with no commits yet, is all added. Outside
  git it returns `null`.
- Builders get a small `iae` MCP server: `map_update` (add nodes and claim paths
  so the map stays truthful), `ask_architect` (raise a question through the
  lead's agenda; `blocking: true` waits for the answer) and `progress` (their
  plan as 3–7 steps, then `done: n` as each finishes). `progress.ts` folds the
  reports into `AgentInfo.progress` (steps, done, the time the finished steps
  took, when the current one began); a `TodoWrite` call counts too. The
  renderer's crew list estimates time left from it (`map/crewTime.ts`), and the
  lead's crew lines carry the step and minutes in.
- On finish: the status becomes `done`/`failed` and `result` is the final
  summary. The node's status becomes `built` (or `broken`), counted per node so
  that parallel builders don't fight over it. Scouts and slash commands never
  change node status. Files are rescanned, any new file the builder didn't
  annotate gets a one-line note (batched, sketch model, `notes.ts`), and the
  lead receives an event digest.
- At most `settings.maxBuilders` run at once. Extra jobs wait in a queue (shown
  as `starting`).
- Builder names come from a pool (Ada, Kit, Rho, Juno, Max, Bea, Lev, Ivy). The
  hue is the pool index modulo 6.

### Continuity: reloads, restarts and building Arxitect with itself

- **A window reload never stops anything.** The engine keeps the project open;
  the renderer starts on a blank `boot` screen and calls `resume()`, which
  re-sends `project/opened` with a snapshot that also carries each agent's
  recent steps and the permission requests still waiting. In `npm run dev`, a
  full reload forced by a builder's edit waits for a quiet moment (nobody
  talking, no reply under way, nothing half typed):
  `scripts/vite-quiet-reload.ts` turns Vite's `full-reload` into an
  `arxitect:reload` message that `src/renderer/src/devReload.ts` acts on.
  Hot-swappable edits still apply at once.
- **Builders survive the app.** Every job is saved to `.iae/crew.json` with its
  Claude Code session id and progress (`crew-persist.ts`). Closing the project
  never marks them stopped, so on the next open unfinished jobs resume their
  session (`resume: sessionId`, told the app restarted) or start over from the
  brief if they never got one.
- **The last project reopens.** `<userData>/session.json` holds the project
  open at quit (or when the window closed); `resume()` reopens it. Closing a
  project yourself clears it.
- **Restarting to load new code.** `npm run dev` is `scripts/dev.mjs`, which
  runs `electron-vite dev` and runs it again whenever the app exits with code
  75. With that supervisor present, `selfwatch.ts` watches the app's own
  `src/main`, `src/preload`, `src/shared`, `package.json` and Vite config, and
  `app/stale` puts **Restart to load changes** in the chrome. `restartApp()`
  shuts the engine down cleanly (jobs saved), then exits with 75 (or, outside
  the supervisor, relaunches).

### Cartographer

On the first open of an existing codebase (no `.iae/map.json`):

1. **Instantly**: a heuristic map from folders and manifests (`package.json`
   workspaces, `apps/*`, `packages/*`, `src/*`, common names such as api,
   server, web, client, db, prisma, infra, .github, config). This takes less
   than 200ms.
2. **Then**: a read-only session (Read/Glob/Grep plus `iae.map_update` and
   `iae.file_notes`) explores and replaces the map with a real hierarchy. That
   means 2–3 levels, `paths` ownership for every node, edges, and one-line notes
   for important files. It emits ops progressively, so the map visibly sharpens.
   The lead greets the user meanwhile.

### Sketcher (architecture autocomplete)

A warm, minimal Haiku session (thinking off, `tools: []`,
`strictMcpConfig`). `draft(text)` calls are debounced (about 350ms), and stale
results are dropped. Each draft is sent whole, along with what's already
sketched for the current utterance. The engine keeps a running **union** per
utterance, so ghosts accumulate as the sentence grows rather than replacing
each other. A component keeps its first key and label, so nothing flickers.
The output is `GhostProposal[]` (median about 1s), and the engine emits
`ghost/proposals`. The renderer also runs an instant local
lexicon (`conversation/lexicon.ts`) so ghosts appear even before the model
answers.

### Pulse

The pulse is a 5s tick. It nudges the lead when **all** of these hold: the user
is idle (presence `idle`, ≥ 20s since the last utterance), the lead is idle and
done speaking, there is no turn in flight, and something **new** is pending. New
means an agenda item the lead hasn't raised, builders at work (one nudge per
build, so the lead uses that time for the next decision), events, or an empty
new project. Each nudge says why. The backoff is 45s → 90s → 180s and resets
when the user speaks. Event digests (build finished or failed, a blocking
question) skip the idle wait but still never talk over the user. A blocking
builder question is typically spoken 3–6s after it is raised.

## Persistence: `<project>/.iae/`

| File | Contents |
|---|---|
| `map.json` | `ArchMap` |
| `agenda.json` | `AgendaItem[]` |
| `decisions.json` | `Decision[]` |
| `transcript.jsonl` | one `TranscriptEntry` per line |
| `notes.json` | `{ [path]: note }`, one-line file meanings |
| `state.json` | `{ leadSessionId, cartographedAt, createdAt }` |
| `crew.json` | `SavedJob[]`: each builder or scout job, its session id and progress |

App-level: `<userData>/recent.json`, `<userData>/settings.json` and
`<userData>/session.json` (the project to reopen at launch).
`ARXITECT_USER_DATA` points userData elsewhere (test runs).

## Packaging

`npm run package` produces `release/mac-arm64/Arxitect.app` with electron-builder
(unsigned, for local use). Claude Code's native binary is unpacked from the
asar (`asarUnpack` in `electron-builder.yml`), and `src/main/index.ts` points
the SDK at it with `IAE_CLAUDE_PATH`. Only main-process runtime modules are
`dependencies`. Everything the renderer uses is bundled by Vite and listed in
`devDependencies`. Speech models aren't packaged. The packaged app downloads
them on first use.

## Voice

- **STT**: Whisper (`onnx-community/whisper-base.en` by default) via
  `@huggingface/transformers` in a Web Worker. It uses WebGPU when available,
  and wasm otherwise. Audio comes from an `AudioWorklet` at 16kHz mono. An
  energy-based VAD with hysteresis decides when speech starts, pauses and ends
  in hands-free mode. At a pause (160ms of silence) the speech so far is
  transcribed straight away; if the person doesn't carry on, that transcript
  is the final one, so it's ready when the turn ends. It also sets the end of
  the turn (`turnEndMs`): ~0.45s after a question, ~0.5s after a finished
  sentence, ~1.3s after "and…". Push-to-talk (hold Space) is always
  available. Interim transcripts run roughly every 1s on the growing buffer
  and feed `draft()`. Each spoken turn logs one `[voice:turn]` line: stop →
  text, sent, first words, voice.
- **Talking over Archie**: while a reply is under way (`tts.onActive`, gaps
  between sentences included) the mic compares itself with what Kokoro is
  playing (`ClipPlayer.levelAt`, the loudest 20ms of the last 300ms) times a
  learned echo gain (`EchoModel`), and speech must stand 2.5× clear of that
  to count. A start over Archie ducks him to 30%; 320ms of speech, or real
  words in the transcript, confirms it and barges in; otherwise he carries
  on. The system voice has no reference, so it gates new utterances instead.
- **TTS**: Kokoro-82M via `kokoro-js` (on transformers.js) in a second Web
  Worker, WebGPU fp32 only (about 12ms per character; fp16 produces NaNs, and
  wasm runs 1.5× slower than real time, so without WebGPU the system voice
  speaks). It loads when a project opens. Speech is chunked by sentence as
  `lead/delta` streams; the first chunk is cut at about 48 characters, at a
  comma or before a joining word, so sound starts sooner. The worker turns
  chunks into 24kHz clips in order, and the renderer schedules them back to
  back on the AudioContext clock (no gaps, and no reliance on `ended` events,
  which can arrive seconds late). Mouth pulses come from loudness peaks in
  each clip. `speechSynthesis` (best installed voice)
  stands in when Kokoro can't run, when the user picks it, or for a reply that
  starts more than 3s before Kokoro is ready. A run of speech never switches
  voice mid-reply. Barge-in stops playback, drops the worker's queue, cancels
  `speechSynthesis` and calls `bridge.interrupt()`.
- Models download on first use, or ahead of time with `npm run voice:setup`.
  The renderer CSP allows huggingface.co for that.
