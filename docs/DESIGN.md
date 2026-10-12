# Arxitect design

Arxitect should feel like an architect's drafting table with a thoughtful partner
beside you. It should not feel like a terminal, an IDE, or a dashboard. These
rules hold for every surface.

## 1. Principles

- **One surface.** A project is one full-bleed map. Everything else is a light
  layer that appears where it applies and leaves when it's done. There are no
  panels, sidebars, tabs or file trees. The one exception is the crew list (top
  left), there only while agents work.
- **Place over list.** A question about Auth sits on Auth. An agent editing the
  session code stands on Auth. A file lives inside the node that owns it. When
  you'd reach for a list, ask instead *where does this belong on the map?*
- **Little text.** Labels have 1–3 words and summaries one line. The lead speaks
  in one or two sentences. Show detail only when someone asks for it, by zooming
  in, selecting or opening the lens.
- **Motion carries meaning.** A node arriving fades and settles. An agent
  changing node glides there. The camera flies you somewhere when the lead says
  "look at this", unless you've been steering in the last few seconds (then it
  only rings the node, if it's on screen). Nothing loops for attention: no
  pulsing orbs, spinners or shimmer.
- **Calm colour.** A charcoal graph-paper canvas, light ink, and one bright blue accent. The
  accent means *the lead* or *this needs you*, so no node kind or agent is tinted
  with it. Agents get bright, distinguishable hues kept clear of the accent.
  Status is told by line style (dashed = planned) more than by colour.
- **Round, not rectangular.** Nodes and figures are discs and rings. Only
  surfaces that must hold running text — the scope frame, cards, sheets, file
  tiles — stay rectangles, and then with a generous radius.

## 2. Tokens

All visual values come from `src/renderer/src/styles/tokens.css`. Components
never hard-code colours. Type uses **Inter** for UI, **Newsreader** (serif) for
the lead's voice, project titles and questions, and **JetBrains Mono** for paths
and code. The serif marks things said by the lead or meant to be read slowly.
Sans marks controls and labels.

## 3. Screen anatomy (project)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ●●●   Recipe Box / API / Auth                        (•Auto)  ⌘K     │ chrome: transparent, drag region
│ ╭──────────────────────────────────╮                                 │
│ │ (A) Ada  Session expiry  ~3 min  │                                 │ crew list, only while agents work
│ │     Editing session.ts           │                                 │
│ │     ━━━━━━━━━━━━━━──────────     │                                 │
│ ╰──────────────────────────────────╯                                 │
│                   ╭───╮            ╭───╮                             │
│                  ( Pages )──────▶ (  Auth ) (A)                      │ nodes are discs
│                   ╰───╯            ╰───╯                             │
│                 web entry      Google sign-in      ╭──────────────╮  │ caption, under the disc
│                                      ┆             │ Keep cookie  │  │ question card,
│                                      ┆·············│ sessions or  │  │ anchored to Auth,
│                                                    │ move to      │  │ led from the rim
│                                                    ╰──────────────╯  │
│                                                                      │
│                Ada is reworking session expiry in Auth.              │ caption (serif)
│              (Archie)[ Ask, decide, or describe a change…      ◦ ]   │ intent line
└──────────────────────────────────────────────────────────────────────┘
```

- **Chrome strip** (top, about 52px, no background, window drag region). On the
  left, after the traffic lights (start at x = 84px), is the breadcrumb: the
  project name in serif, then scopes split by thin `/`. Each crumb navigates up.
  On the right: **Restart to load changes** (only when Arxitect is running from
  source and its own main-process code changed), **Auto**, and a faint `⌘K`.
- **Crew list** (top left, under the breadcrumb, only while agents work). One
  row per agent: its mark, name and task; the line it's on now, in plain
  words: the step of its plan ("Failed jobs try again"), else the kind of
  work ("Reading the code"), never a file or command; a 2px bar in its hue for how far through its own plan it is; and
  at the right end, roughly how long is left ("~3 min left"), once a step has
  finished and there's something to estimate from. Before that it shows the
  step ("Step 1 of 4"), and with no plan, how long it has been going. A row
  opens to show the plan, **Show** (fly to where it's working) and **Stop**.
  Between the plan and the actions, an opened row lists what the builder
  **Changed**, newest first: the file name in mono `--ink-2` (with its folder
  only when two share a name), a quiet "new" for a file it created, and
  `+added −removed` right-aligned, where only the numbers take `--ok` and
  `--bad`. It lists up to eight, then "and N more". Each file opens the lens on
  its Changes. Closed, the row says only how many files ("3 files", `--ink-4`)
  at the right end of its activity line.
  The bar creeps within a step but never passes the step's end until the
  builder says it's done. Nothing in it loops or shimmers. A permission request
  whose token is off screen hangs under the agent's row.
- **Map**: the full window.
- **Caption + intent line**: bottom centre, about 24px from the bottom edge.

## 4. The map

### Scopes and semantic zoom

The map always shows **one scope**, which is the children of one node (or the
project's top level). Diving into a node makes it the scope.

- **Dive**: double-click a node, press ↵ on a selected node, or keep zooming in
  on a node. The camera flies into the node and its children fade in. The
  parent remains as a large, faint frame around them, with its label in serif at
  the top-left of the frame.
- **Surface**: press Esc, click a breadcrumb, or zoom out past the threshold.
  The camera pulls back and the siblings return.
- **Continuous zoom** (pinch or ⌘-scroll) works inside a scope. Past roughly 2.2×
  with one node filling most of the view, the map dives. Below roughly 0.55× it
  surfaces. Use hysteresis so it never flaps.
- **Boundary stubs**: inside a scope, edges that leave the scope end at the
  frame's border as short stubs labelled with the outside node ("→ Postgres").
  Clicking a stub navigates there.
- Fit the content with padding that keeps clear of the chrome (top 64px) and
  the conversation zone (bottom 168px: the intent line plus a three-line
  caption). Nothing on the map sits under the conversation by default.

### Layout

ELK `layered`, direction RIGHT. Clients sit on the left, services in the middle,
and data and externals on the right. Allow generous spacing (≥ 72px between
layers, ≥ 40px between nodes). Layout is computed per scope and animated: nodes
glide to new positions and never jump. Adding a node must not reshuffle the
whole map. Keep it stable by seeding ELK with prior positions (or
`interactive` strategies) where possible.

### Nodes

- **A node is a disc.** `--paper-raised` with a soft radial lift, a 1px `--line`
  rim, and a second fainter ring inset inside it — the quiet HUD doubling.
- **Leaf** node (no children) is 140px across. **Container** node (has children)
  is 180px and carries a *third* ring outside the rim, so depth is visible before
  diving.
- **Inside the disc** (centred, max 70% of the diameter so the words keep clear
  of the curve): a kind glyph (tinted `--kind-*`), the label (12.5px, weight 560,
  up to two lines; 14px on a container), and the file count under it (`--ink-3`,
  mono 10px).
- **Under the disc**, in a caption 212px wide: the one-line summary (11px
  `--ink-2`, ellipsis) and, for a container, up to four child chips plus "+N".
  A circle has no room for running text, so the text sits outside it; `CAPTION`
  in `layoutTypes.ts` is the room this needs, and ELK's node spacing leaves it.
- **Status by line**: *planned* has a dashed `--line-strong` rim, translucent
  fill and an `--ink-2` label. *Building* has a slow sheen travelling around the
  rim in the working agent's hue (one sweep per ~2.4s, low contrast). *Built* is
  solid. *Broken* has a `--bad` rim and a small mark at 4 o'clock.
- Hover: scale 1.025, `--shadow-2`. Selected: an `--accent` rim with a soft glow.
  Selecting a node scopes the conversation ("About Auth…").
- **Plain English first, technical detail on demand.** Labels name the role
  ("Window ↔ Brain Link"); on hover or selection a muted mono line opens above
  the summary with the developer's name (`techLabel`, `--ink-2`) and as many
  whole stack items as fit, up to three (`--ink-3`): "IPC Bridge · Electron IPC".
  Nodes without either look exactly as before.
- **Changed**: a node owning a file a builder changed carries a small dot in
  that builder's hue on the rim at 8 o'clock (the broken mark has 4), lifted
  to the visible ancestor. It arrives once (a short scale-in) and stays while
  the builder is on the crew list, so a finished change leaves its footprint
  across the system until it's cleared.
- **Activity bloom**: when an agent touches a file under a node, the visible
  ancestor gets one soft ring in the agent's hue that expands and fades
  (~900ms). It's rate-limited and never loops.
- Glyphs are hand-drawn as simple 1.5px-stroke SVGs, one per `NodeKind`. They
  are consistent and geometric. Don't use emoji or icon fonts.

### Files

Files appear only inside the node that owns them:

- In a scope, files owned directly by the scope node (not by a child) sit on a
  quiet **file shelf** inside the frame. Each is a small chip with a type glyph
  and the name in mono 11.5px.
- Diving into a leaf node shows its files as tiles laid out in a calm grid. In
  **meaning mode** (⌘M) each tile shows its one-line `note` instead of only the
  name.
- Clicking a file opens the **lens**.

### Edges

Rounded orthogonal paths from ELK, 1.25px `--line-strong`, with a small
arrowhead. `events` are dashed and `auth` dotted. Labels appear as a small pill
at the midpoint only when zoom ≥ 0.9. Where several edges converge and their
pills would stack into a column, the earlier (more important) labels show
first; the rest wait for a closer zoom, or appear while one of their ends is
hovered or selected. When an agent's work flows along an edge,
a single dot travels it once. It never streams continuously.

### Agents on the map

Each active builder is a small token, a tiny Archie in its hue, docked at the
top-right corner of the node it's working in (lifted to the visible ancestor).
A thin ring outside the token's halo fills one segment each time it finishes
a step of its plan (no creeping, no loop). What it's on now replaces the
node's summary in the caption: a 6px dot in its hue and the plan step in
`--ink` ("Failed jobs try again"), or before a plan the kind of work
("Reading the code"). Everything shown is in the person's terms: no file
names, commands or code; those wait in the crew row and the lens. When the agent changes node, the
token **glides** along a gentle curve (spring). Several agents on one node line
up side by side. Hovering a token on the map opens a small
card with its task, what it's doing now, and a quiet "Stop". A permission request shows as a small pill attached to the
token, such as "Run `npm test`?", with ✓ and ✕.

### Ghost nodes (architecture autocomplete)

While the user speaks or types, likely components appear as **ghosts**. A ghost
is the same disc drawn in dashes: an `--accent` outline, an `--accent-ink` label
in serif italic, a faint outward glow and 55% opacity. It
fades in near the node it relates to, and dashed ghost edges hint at its
connections. When the lead commits the node with the same id, the ghost
**becomes** the node in place. When the utterance ends without it, the ghost
dissolves (about 1.5s after the lead's map changes). Each idea shows once
("API" and "API Server" are one ghost; a generic "Database" yields to
"Postgres"). On a bare canvas ghosts form a calm centred grid, clients on the
left, services in the middle, data and externals on the right; on a map they
sit near what they relate to, in free space in view. A ghost keeps its spot
while it can, so ghosts never reshuffle as more arrive. This makes "every word moves the map" visible.

### Questions on the map

The open agenda item with the highest priority appears as a **question card**
anchored to its node: a small card (≤ 300px) offset to the free side, clear of
nodes and edges, joined by a short dotted accent leader (dotted and accent so it
never reads as one more edge). The leader leaves from the disc's rim — and below
a node, from under its caption, so it never crosses the node's own words. The
card has an accent left rule, the prompt in serif 15px, the
`why` in 12px `--ink-3`, and 2–4 option pills. The first pill is the
recommendation (`--accent-wash` fill), the rest are outlined. It also has "later" and
"×". **Only one card is visible at a time.** A card never sits under the chrome
or the conversation zone: it slides along its side, picks another side, or the
camera eases once to make room (never while the user is steering). Zoomed far
out (below about 0.38×) the card steps aside and its dot stands in. Other open
items show as small accent dots on their nodes. A card shows when its node is
visible, or one level inside a visible node (eyebrow "In Groups"); deeper than
that, the visible ancestor shows the dot, and clicking it flies there. A card
about the scope itself sits outside the frame, never over its children.

## 5. The conversation surface

- **Intent line**: a pill (`min(640px, 60vw)` × 52px, `--paper-raised`,
  `--shadow-2`, 1px `--line`). Archie perches on its left end. Input is 15px.
  On the right is a mic glyph. When hands-free mode is on, the glyph becomes a
  three-bar level meter. When empty and idle, a faint hint reads `hold space to
  talk`.
- The placeholder follows context:
  - New project: "Describe what you're building…"
  - Default: "Ask, decide, or describe a change…"
  - Node selected: "About Auth…"
  - A question card is up: "Answer, or say something else…"
- Typing `/` opens Claude Code commands and skills above the line.
- **Caption**: the lead's words, centred above the intent line, Newsreader
  17px, at most three lines (`max-width: 680px`). Words fade in as they stream.
  A longer reply shows its latest *whole* sentences, never a line cut in half.
  The caption lingers after speech ends (6–12s, about four words a second),
  then fades. Clicking it, or
  pressing ⌘J, opens the **transcript**, a calm column on a sheet with no chat
  bubbles. The lead is in serif and the user in sans.
- The user's interim speech shows live inside the intent line in `--ink-2`.

## 6. Archie, the lead

Archie is an original character: a small, round, accent-blue creature with two raised
claws and two tall ink eyes. It has the warmth of the Claude Code crab but is
not a copy of it. It is SVG, 40px on the intent line and 96px on Home. Builders
belong to the same family: smaller (18px) and tinted with their hue.

States are subtle and readable at a glance:

| State | Signal |
|---|---|
| idle | Still. Blinks every 3–6s. Eyes drift slightly toward the cursor. |
| listening | Leans in (~-4°). Eyes widen and look at the input. Body squashes gently with the mic level. |
| thinking | Eyes glance up and to the side. One claw taps slowly. No spinner. |
| speaking | A small mouth opens and closes with the speech. |
| has a question | Raises one claw, like a raised hand. The only "needs you" signal besides the card. |
| crew working | Occasionally glances toward the map. |

## 7. The lens

Click a file and a sheet rises from the bottom over a lightly dimmed map
(`min(880px, 82vw)` × 72vh, radius `--r-xl`, `--shadow-3`).

- Header: the path in mono, with directories in `--ink-3` and the filename in
  ink. It also has the owning node as a chip (click to focus the node), a
  `Code · Meaning` toggle, and close.
- **Code**: CodeMirror 6 on the lens, themed from the tokens (it declares
  `dark: true` so CodeMirror never reaches for its light base styles). Keywords
  are accent, strings
  sage, numbers ochre and comments ink-3 italic. It is editable, and ⌘S saves
  with a quiet "Saved".
- **.env files** get a key/value editor. Each row has `KEY` in mono, a value
  field that is masked by default and can be revealed, and a comment line. This
  is the canonical "I need to change my .env" moment, so make it lovely.
- **Meaning**: a plain-language explanation of what the file does and what uses
  it.
- **Changes** (a third option in the toggle, `Code · Changes · Meaning`, shown
  when the file differs from the last commit or the crew list asked for it):
  the file's diff against git `HEAD`, read-only, on the same CodeMirror paper
  and syntax colours as Code. Added lines sit on `--ok-wash` and removed lines
  on `--bad-wash`, across the gutter too. The gutter holds the old and new line
  numbers (`--ink-4`, mono 11px) and a small `+`/`−` in `--ok`/`--bad`. Hidden
  lines between hunks are a quiet recessed band ("Line 40" in `--ink-3`, then
  the enclosing function in `--ink-4`), with no band above line 1. One line
  over the diff tallies it ("+24 −6 since the last commit"). A file with no
  changes, a binary file or a project without git get a calm serif line, never
  an error. `.env` files have no Changes view, so secrets stay masked.
- Footer: "Ask Archie to change this…". It sends with the file as context.
- Esc closes it, and the camera is left where it was.

## 8. Home

The screen is calm and centred. Archie sits at 96px, idle. The serif display
line reads *What are we building?* Below it are two actions: **New project**
(an inline name field that creates the folder on Enter) and **Open a folder…**.
Next is a list of recent projects, each showing the name in serif 20px, a
summary in `--ink-3`, the path in mono 11px `--ink-4` and a relative time. At
the bottom is a quiet line for Claude Code status.

## 9. Command palette (⌘K)

A small centred popover with fuzzy search. It offers: go to node, find file
(navigates to the owning node and opens the lens), open or new project,
meaning mode, speak replies, hands-free, Claude Code commands and skills,
settings (lead name, models, autonomy) and transcript.

## 10. Keyboard

| Key | Action |
|---|---|
| hold Space (not typing) | push to talk |
| ↵ | dive into selected node / send |
| Esc | close lens → clear selection → surface one scope |
| ⌘K | palette |
| ⌘J | transcript |
| ⌘M | meaning mode |
| ⌘0 | fit scope |
| ⌘. | interrupt the lead |

## 11. Motion

| Thing | Spec |
|---|---|
| Camera fly / dive | 720ms, d3 `interpolateZoom` (smooth zoom-and-pan) |
| Node enter | opacity 0→1, scale .96→1, 320ms `--ease-out`, 30ms stagger |
| Node exit | opacity →0, 200ms |
| Layout change | positions tween 420ms `--ease-in-out` |
| Agent glide | spring (stiffness ~120, damping ~18) |
| Question card | fade + rise 8px, 260ms |
| Caption words | fade per word, 180ms |

Respect `prefers-reduced-motion`.

## 12. Copy

Use sentence case. Be short, warm and concrete. Never use exclamation marks,
emoji or "AI-powered". Agents have human names (Ada, Kit, Rho, Juno, Max,
Bea). Use real labels: say "Waiting on you" instead of "Blocked: user input
required".
