# IAE: Integrated Architecture Environment

IAE is a desktop app for designing software with Claude. It runs on Claude Code
(through the Claude Agent SDK), but the human doesn't type code into a terminal
here. They **architect and ideate**. Claude builds. The screen shows one living
architecture map of the system, a small companion called Archie (the lead) who
talks with you, and the agents who do the building, each shown on the part of
the map where it is working.

> North star: someone who uses Claude Code in a terminal today switches to IAE
> because it is clearer, faster and more fun. It has no idle time, and they
> understand their own system better than before.

Read these before making product or design decisions:

- `docs/PRD.md`: the original PRD and how IAE departs from it
- `docs/DESIGN.md`: visual language, interaction model, motion, copy
- `docs/CONVERSATION.md`: how the lead thinks, talks, asks and never idles
- `docs/ARCHITECTURE.md`: processes, engine, data flow, Claude Code integration

## Principles (non-negotiable)

1. **The map is the interface.** There are no panels, sidebars or file trees.
   Files live *inside* the nodes that own them. To find `.env` you open Backend,
   then Config, and the file is there. Everything has a place you can point at.
2. **Quiet by default.** Light paper, ink, and one clay accent. Show as little
   text as possible. If something needs the user, it appears *where it applies*
   (on its node), not in a list.
3. **No idle time on either side.** While agents build, the lead uses the time
   to settle the next real decision. While the user talks, the map sketches what
   they say as they say it (ghost nodes, which work like autocomplete).
4. **Specific, never generic.** Every question the lead asks names real parts of
   *this* system and offers a recommended default. Never ask "What would you like
   to do next?"
5. **Intentional motion only.** Nothing pulses to get attention. Movement always
   means something: an agent moved, a node was born, the camera is taking you
   somewhere.
6. **Claude Code underneath, intact.** Builders are real Claude Code sessions
   with the user's skills, plugins, CLAUDE.md, MCP servers and permissions.
   Slash commands work from the intent line (`/review`, `/init`, …).

## Stack

Electron 44 · electron-vite 5 · React 19 · TypeScript · zustand · d3-zoom ·
elkjs · motion · CodeMirror 6 · `@anthropic-ai/claude-agent-sdk` ·
`@huggingface/transformers` (on-device speech-to-text) · CSS Modules + tokens.

## Commands

```bash
npm install
npm run dev          # desktop app with hot reload (real Claude via your Claude Code login)
npm run web          # renderer only, in a browser, against the mock engine → http://localhost:5199
npm run build        # production bundle into out/
npm run typecheck    # both tsconfigs (node + web)
npm test             # vitest (shared/ + engine pure logic)
npm run voice:setup  # optional: pre-download the speech model for offline voice
```

Auth: IAE uses whatever Claude Code uses. If `claude` works in your terminal,
IAE works. `ANTHROPIC_API_KEY` is honoured if set.

## Layout

```
src/
  shared/             contracts used by BOTH processes. Pure TS, no Node/DOM.
    model.ts          domain types: ArchNode, ArchEdge, AgentInfo, AgendaItem, Settings…
    events.ts         EngineEvent: everything main → renderer
    bridge.ts         IaeApi: everything renderer → main (+ BRIDGE_METHODS)
    map.ts            pure map ops: applyOps, liftedEdges, ownerOf, describeMap…
  main/               Electron main process
    index.ts          window + boot
    ipc.ts            generic IPC plumbing (don't add per-method handlers)
    engine/           the brain: lead, builders, cartographer, sketcher, agenda
    project/          .iae persistence, file scanning/watching, heuristic map
  preload/index.ts    exposes window.iae (typed IaeBridge)
  renderer/src/
    state/store.ts    zustand store + reduce(EngineEvent). Only place engine state is folded.
    bridge/           window.iae or the mock (browser dev)
    map/              the architecture canvas: camera, layout, nodes, edges, agents, questions
    conversation/     intent line, captions, ghost autocomplete, turn-taking
    voice/            speech-to-text worker, VAD, text-to-speech
    avatar/           Archie: the companion and its states
    lens/             focused file/node view (read, edit, explain)
    home/             project picker
    palette/          ⌘K command palette
    styles/           tokens.css (design tokens), global.css
```

Per-project state lives in the user's project at `<project>/.iae/`
(`map.json`, `agenda.json`, `decisions.json`, `transcript.jsonl`, `state.json`,
`notes.json`).

## Conventions

- **Contracts first.** If a change crosses the process boundary, change
  `src/shared/*` first, then the engine, the mock (`bridge/mock.ts`) and the
  store reducer. The mock must keep implementing `IaeApi`.
- **All map changes are `MapOp`s.** Never mutate `ArchMap` in place. Use
  `applyOps`.
- **Styling:** CSS Modules (`Thing.module.css`) next to components, and only the
  variables in `styles/tokens.css`. No raw hex values in components, no
  Tailwind, no UI kits. Clay (`--clay`) is reserved for the lead, things that
  need the user, and primary actions.
- **Components select narrowly** from the store: `useIae((s) => s.map)`.
- **Copy:** sentence case, short and human. No exclamation marks, no emoji, no
  "AI" word salad. Agents have names (Ada, Kit, …), not "Agent 3".
- **Models:** lead `claude-opus-5-5` at `effort: 'low'` (fast, warm session),
  builders `claude-opus-5-5`, sketcher `claude-haiku-4-5`. All configurable in
  Settings.
- The lead session must stay lean: `strictMcpConfig: true`, `tools: []`, a
  custom system prompt, and only IAE's in-process MCP tools. With that it
  replies in about 1 second. Builders get the full Claude Code preset.
- Keep files focused (< ~400 lines). Prefer small modules over clever ones.
- macOS is the primary target. Don't break other platforms gratuitously.

## Testing & verification

- `npm run typecheck` and `npm test` must pass.
- UI work: run `npm run web` and look at it (Chrome, or Playwright screenshots
  via `scripts/shoot.mjs`). The mock engine simulates agents, questions and
  replies, so every surface can be seen without Claude.
- Engine work: `scripts/smoke-engine.mjs` drives a real lead turn against a
  temp project (needs Claude Code auth).
- Before calling a UI change done, look at a screenshot. Check it against
  `docs/DESIGN.md`.
