# Using Arxitect

Everything Arxitect can do, and how to get the most out of it.

Arxitect is a desktop app for designing software with Claude. You don't type code
into a terminal here — you architect and ideate, and Claude builds. The screen
is one living map of your system, a lead called Archie who talks with you, and
the builders who do the work, each standing on the part of the map they're
changing.

Two ideas run through everything below:

- **The map is the interface.** No panels, sidebars or file trees (only a
  quiet crew list while agents work). Files live *inside* the node that owns
  them. To find `.env` you open API, then Config, and it's there.
- **Nobody waits.** While builders work, Archie uses the time to settle the
  next real decision. While you talk, the map sketches what you're saying.

---

## 1. Getting set up

```bash
npm install
npm run dev
```

You need Claude Code installed and signed in. **If `claude` works in your
terminal, Arxitect works** — it uses the same login. `ANTHROPIC_API_KEY` is honoured
if you've set one.

One optional extra, worth it if you intend to talk rather than type:

```bash
npm run voice:setup    # ~700MB: speech-to-text and Archie's voice, on-device and offline
```

Archie's voice is Kokoro, a speech model that runs on your Mac (on the GPU when
it can). It starts loading the moment the app opens, and Archie only ever
speaks in that one voice: a reply that arrives before Kokoro is ready waits for
it, and if the wait runs long that reply stays on screen without being spoken.
Without `voice:setup`, Kokoro downloads the first time, so Archie is silent
until it's ready. The macOS system voice speaks only if you pick it in
Settings, or if Kokoro can't run on this Mac at all.

Other commands you may want:

| Command | What it does |
|---|---|
| `npm run dev` | The desktop app, hot reload, real Claude |
| `npm run web` | Renderer only in a browser against a mock engine — every surface without using tokens |
| `npm run build` | Production bundle into `out/` |
| `npm run package` | `release/mac-arm64/Arxitect.app` (unsigned, local use) |
| `npm test` / `npm run typecheck` | The checks |

---

## 2. Starting a project

The Home screen offers two doors, and remembers where you've been. If a
project was open when you quit, Arxitect opens straight back into it, and any
builder that hadn't finished picks up where it left off.

- **New project** (`⌘N`) — name it, and Arxitect creates the folder and opens a
  blank canvas. Archie greets you and asks what you're building.
- **Open a folder…** (`⌘O`) — point at any existing repo.
- **Recent** — arrow keys move, `↵` opens.

**Opening an existing codebase is the trick worth knowing.** A rough map appears
instantly from file-structure heuristics. Then **Atlas**, a fast read-only
cartographer, actually reads the code — manifests, entry points, routers,
schemas, config — and over about a minute the map sharpens into the real
architecture. Atlas never modifies anything. When it's done, Archie tells you
what kind of system it is and asks what you're changing today. It often spots
genuine gaps on its own.

Everything Arxitect knows about your project lives in `<project>/.iae/` —
`map.json`, `agenda.json`, `decisions.json`, `transcript.jsonl`, `state.json`,
`notes.json`, `crew.json`. It's plain JSON, it's yours, and it's git-ignorable.

---

## 3. Talking to Archie

The intent line sits at the bottom. Its placeholder tells you what it's for
right now — *"Describe what you're building…"* on a blank project, *"About
Auth…"* when a node is selected, *"Answer, or say something else…"* when a
question is waiting.

### Three ways to say something

- **Type** and press `↵`.
- **Hold `Space`** and talk (push-to-talk). Release to send. Outside a text
  field it starts instantly; inside the intent line it waits 200ms and only
  when the line is empty, so typing spaces never triggers it.
- **Hands-free** — click the mic once and just talk, for as long as you like.
  Arxitect listens continuously and works out your turns by itself: about half
  a second of silence after something that sounds finished ends your turn, and
  it waits longer when you trail off on *"and…"* or *"so…"*. Your words are
  already transcribed by the time your turn ends, so Archie usually starts
  answering within about two seconds.

### What's worth saying

Archie is built to never ask a generic question, so you get the most from it by
being concrete about intent and letting it handle structure:

- Describe the *system*, not the files: *"a group of friends plans hiking trips
  together: one organiser proposes trails and dates, everyone votes, and we
  share a packing list."*
- Decide out loud: *"web app is fine"*, *"go with short-lived tokens"*, *"keep
  cookie sessions"*.
- Delegate: *"go ahead and build the trips API"*.
- Ask about what you're looking at: say *"this"*, *"here"* or *"that file"* and
  Archie resolves it from what's on your screen — the scope you're in, the node
  you selected, the file open in the lens.

### Ghost nodes — architecture autocomplete

While you're still talking, parts of the system sketch themselves onto the map
as dashed translucent discs. They accumulate as you speak and settle into real
nodes when Archie commits them. You don't act on ghosts; they're Arxitect thinking
along with you, and they're the fastest way to tell whether you've been
understood.

### Interrupting

Just talk over him. In hands-free, Archie dips the moment you start, and stops
once it's clear you're talking — a cough or a door doesn't cut him off, and his
own voice coming back through your speakers never counts as you. `⌘.` stops
him mid-sentence and interrupts the reply in flight; holding `Space` does the
same the moment you start talking. If Archie is still thinking when you cut
in, the reply that was on its way stays silent rather than talking over you.

(With the system voice instead of Kokoro, talking over him needs `Space` or
`⌘.`: that voice plays outside the app, where its echo can't be told apart from
you.)

---

## 4. The map

### Reading it

A node is a **disc**. Inside: a kind glyph, the label, and the file count.
Underneath, in a caption: what it does, and for a node with children, its
children's names. Labels are plain English; hover or select a node to see the
name a developer would use and its tech stack.

| What you see | What it means |
|---|---|
| Solid rim | Built |
| Dashed rim | Planned, not built yet |
| A sheen travelling the rim | A builder is working here right now, in that builder's colour |
| Red rim and a small mark | Something here is broken |
| A third ring outside the rim | This node has children — you can dive into it |
| A bright blue ring | Selected |

Line style carries meaning too: solid edges are calls and reads and writes,
dashed are events, dotted is auth.

### Moving around

| Action | |
|---|---|
| Scroll / pinch | Zoom |
| Drag | Pan |
| Click a node | Select it — the conversation scopes to it (*"About Auth…"*) |
| Double-click, or `↵` | Dive inside it |
| `Esc` | Clear selection, then surface one level |
| Arrow keys | Move the selection to the nearest node that way |
| `⌘0` | Fit everything on screen |

**Semantic zoom:** the map shows less as you pull back and more as you push in,
across five levels. Zoom right out and question cards step aside for small dots
so they never cover the map they're about.

**Diving is the whole navigation model.** There is no file tree. API → Config →
`.env` is how you reach that file, and it's always the same path.

---

## 5. Questions, decisions and the agenda

Archie keeps an agenda of open decisions. The most important one appears as a
**question card** pinned to the node it's about, joined by a dotted leader.

A good card has a recommended option first. **Click it, or just say it** —
*"go with the first one"*, *"short-lived tokens"*, *"either is fine"*. Archie
understands short answers in context.

- **later** parks the question without losing it.
- **×** dismisses it.
- Other open questions sit as small blue dots on their nodes. Click one to
  bring it up.
- Only ever one card at a time. It never covers a node, an edge it's about, or
  the conversation.

Decisions you settle are recorded in `.iae/decisions.json`, and Archie recalls
them honestly rather than re-asking.

---

## 6. Builders

Say *"build it"* and a builder appears on the map — a named figure (Ada, Kit,
Rho, Juno, Max, Bea, Lev, Ivy) standing on the node it's changing, with a
one-line description of what it's doing right now.

Builders are **real Claude Code sessions**. They load your `CLAUDE.md`, your
skills, plugins, hooks, MCP servers and permissions. Nothing is simulated.

- **The crew list** (top left) has a row for each agent at work: what it's
  doing this moment, a bar for how far through its plan it is, and roughly how
  long it has left. Each builder sends its own plan once it has looked around,
  and the estimate comes from how long its finished steps took. **Click a row**
  for the plan, **Show** (fly to where it's working) and **Stop**.
- **See what it changed.** A row counts the files its builder has edited
  ("3 files"); opened, it lists them under **Changed**, newest first, each with
  the lines added and removed (**+24 −6**, marked **new** if the builder created
  the file). Click one and the lens opens on that file's **Changes**: what's
  different since the last commit, added lines in green, removed in red, with
  the old and new line numbers. **Code** goes back to the plain file, which
  you can edit. The counts are taken from each edit as it lands; the lens shows
  the file against git, so it also includes changes from before the job. A
  builder that changed files stays on the list when it's done, so you can
  review it; **Clear** takes it off (the oldest go by themselves after four).
- **Hover a builder on the map** for its task, its current activity, and a
  quiet **Stop**.
- A builder that needs permission shows a **pill on the map** with the actual
  command. **✓** allows, **✗** denies. It appears where the work is happening,
  not in a queue somewhere.
- When a file under a node changes, that node gets one soft ring in the
  builder's colour. It never loops or nags.
- Run several at once — up to 8, 3 by default.
- **Builders don't lose their place.** A window reload doesn't touch them, and
  if the app quits mid-job they resume their own Claude Code session the next
  time the project opens.

While they work, Archie keeps talking to you, and knows how far along each one
is. The bar is there to glance at, not to watch.

---

## 7. The lens — reading and editing files

Click any file to raise the lens over the map. `Esc` closes it and leaves the
camera exactly where it was.

| | |
|---|---|
| `⌘S` | Save |
| `⌘F` | Find in file |
| `⌥Z` | Wrap long lines |
| `Esc` | Close (asks first if you have unsaved changes) |

- **Code / Meaning** — switch between the file and a plain-language explanation
  of what it's for.
- **Changes** — appears when the file differs from the last commit (git
  `HEAD`): every changed passage with three lines of context around it, added
  lines in green and removed in red. A file git doesn't track yet shows as all
  new. `⌘F` finds within it. It follows along while a builder edits the file.
  `.env` files never show it, so their values stay masked.
- **The owner chip** in the header jumps to the node that owns this file.
- **Ask bar at the bottom** — ask Archie to change this file without leaving
  it. The request carries the path as context, and the reply streams in above
  the field.

### The `.env` editor

Open any `.env` and you get one calm row per variable instead of raw text.

- Values are **masked** until you press **Show values**, or reveal one with the
  eye.
- **Comments become structure** — section headings and per-key notes come from
  the comments already in your file.
- The file **round-trips byte-for-byte** for everything you didn't touch.
- **Edit as text** drops to the raw file whenever you'd rather.

### Meaning mode (`⌘M`)

Toggle it anywhere and every file name on the map turns into what that file is
*for*. It's the fastest way to understand a codebase you've just opened.

---

## 8. The command palette (`⌘K`)

One box for everything. Type to filter; it searches across all of these at
once:

- **Commands** — New project, Open project…, Meaning mode, Speak replies,
  Hands-free voice, Show transcript, Settings, Close project.
- **Go to** — any node on the map, including ones outside your current scope.
  Picking one flies you there.
- **Files** — fuzzy path search across the project. Opens the lens *and* moves
  the map to the owning node.
- **Claude Code** — your actual slash commands and skills.
- **Projects** — switch to another recent project.
- **Ask Archie** — if nothing matches, your query becomes a question for Archie.

`↑↓` move, `↵` opens, `Esc` closes.

### Claude Code commands

**Type `/` in the intent line** (or in `⌘K`) to see your real Claude Code
commands and skills — `/code-review`, `/security-review`, whatever you have
installed. Pick one and it runs as a builder on the map, with arguments if you
pass them.

This is the thing to remember: Arxitect doesn't replace Claude Code, it gives it a
map. Everything you've configured still applies.

---

## 9. The transcript (`⌘J`)

The full conversation, when you want to look back at it. It's also on disk at
`.iae/transcript.jsonl` if you'd rather read it there.

---

## 10. Settings (`⌘K` → Settings)

Each change saves on its own.

| Setting | |
|---|---|
| **Lead's name** | Archie by default. Call it whatever you like. |
| **Lead model** | Tuned to answer in about a second. |
| **Builder model** | Does the real work in each Claude Code session. |
| **Builders ask** | See below. |
| **Builders at once** | 1–8, default 3. |

### Builders ask — the setting that changes how Arxitect feels

| Choice | |
|---|---|
| **Ask first** | Builders ask before they change a file or run a command. |
| **Ask before commands** *(default)* | Builders change files on their own, and ask before running a command. |
| **Never ask (Auto)** | Builders go ahead without stopping. Best in a git repo, where every change can be undone. |

If you find yourself approving the same pill over and over, this is the knob.
**Auto** at the top right is the same "never ask", one click away: turning it on
also approves everything already waiting.

### Voice settings

Toggle **Speak replies** and **Hands-free voice** from `⌘K` directly. Pick
Archie's voice in **Settings → Voice**: step through the Kokoro voices (Heart is
the default) and each one speaks as you land on it. The last stop, **System
voice**, uses the best voice macOS has installed instead — Premium above
Enhanced above Siri above stock, never the novelty voices — so a premium voice
from **System Settings → Accessibility → Spoken Content → System voice → Manage
voices** is used when you choose it.

A note on hands-free: while Archie is speaking, the microphone is deliberately
shut, because your speakers would otherwise feed his own voice back into it.
To interrupt him by voice, hold `Space`; `⌘.` also stops him instantly.

---

## 11. Every shortcut

| Key | |
|---|---|
| hold `Space` | Talk (push-to-talk) |
| `↵` | Send — or dive into the selected node when the line is empty |
| `⌘.` | Interrupt Archie |
| `⌘K` | Command palette — everything else |
| `⌘J` | Transcript |
| `⌘M` | Meaning mode |
| `⌘0` | Fit the map on screen |
| `⌘N` | New project |
| `⌘O` | Open a folder |
| `Esc` | Close lens → clear selection → surface a level |
| arrows | Move the selection |
| double-click | Dive into a node |
| `⌘S` | Save (in the lens) |
| `⌘F` | Find (in the lens) |
| `⌥Z` | Wrap long lines (in the lens) |
| `/` | Claude Code commands, from the intent line |

On Windows and Linux, `Ctrl` stands in for `⌘`.

---

## 12. Getting the most out of it

- **Open an existing repo and let Atlas finish before you ask anything.** The
  first minute is the cheapest architecture review you'll get.
- **Talk, don't type.** The ghost nodes only sketch while you speak, and the
  whole turn-taking design assumes voice. Run `npm run voice:setup` first.
- **Answer the card and move on.** Archie's questions always carry a
  recommended default — taking it is usually right, and you can revisit.
- **Delegate early and keep talking.** The design assumes a builder is running
  while you settle the next decision. If you're watching a build, you're using
  it wrong.
- **Use `⌘M` on unfamiliar code.** Meaning mode over a fresh repo is the
  fastest orientation available.
- **Let the map be your file tree.** Looking for something? Find the node that
  owns it and dive. It's faster than searching, and you learn the system.
- **Turn on Auto in a git repo.** Builders that never wait, three or more at
  once, while you keep talking, is a different experience; git keeps every
  change undoable, and the crew list shows what each one changed.

### Building Arxitect with Arxitect

Run it from source with `npm run dev` and open the Arxitect repo itself.
Builders' changes to the window (the renderer) load as they're saved; the
window reloads and the crew carries on. Changes to the engine (`src/main`,
`src/preload`, `src/shared`) only load in a fresh process, so a **Restart to
load changes** button appears at the top right. Click it when you like:
Arxitect rebuilds, comes back on the same project, and every unfinished
builder resumes its session.
