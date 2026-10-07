# Using IAE

Everything IAE can do, and how to get the most out of it.

IAE is a desktop app for designing software with Claude. You don't type code
into a terminal here — you architect and ideate, and Claude builds. The screen
is one living map of your system, a lead called Archie who talks with you, and
the builders who do the work, each standing on the part of the map they're
changing.

Two ideas run through everything below:

- **The map is the interface.** No panels, sidebars or file trees. Files live
  *inside* the node that owns them. To find `.env` you open API, then Config,
  and it's there.
- **Nobody waits.** While builders work, Archie uses the time to settle the
  next real decision. While you talk, the map sketches what you're saying.

---

## 1. Getting set up

```bash
npm install
npm run dev
```

You need Claude Code installed and signed in. **If `claude` works in your
terminal, IAE works** — it uses the same login. `ANTHROPIC_API_KEY` is honoured
if you've set one.

Two optional extras, both worth it if you intend to talk rather than type:

```bash
npm run voice:setup    # ~270MB: on-device speech-to-text, works offline
```

For a markedly better voice for Archie, install a premium system voice:
**System Settings → Accessibility → Spoken Content → System voice → Manage
voices → English → Ava (Premium)** or **Zoe (Premium)**. IAE finds and prefers
it automatically — it ranks Premium above Enhanced above Siri above stock, and
never picks the novelty voices.

Other commands you may want:

| Command | What it does |
|---|---|
| `npm run dev` | The desktop app, hot reload, real Claude |
| `npm run web` | Renderer only in a browser against a mock engine — every surface without using tokens |
| `npm run build` | Production bundle into `out/` |
| `npm run package` | `release/mac-arm64/IAE.app` (unsigned, local use) |
| `npm test` / `npm run typecheck` | The checks |

---

## 2. Starting a project

The Home screen offers two doors, and remembers where you've been.

- **New project** (`⌘N`) — name it, and IAE creates the folder and opens a
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

Everything IAE knows about your project lives in `<project>/.iae/` —
`map.json`, `agenda.json`, `decisions.json`, `transcript.jsonl`, `state.json`,
`notes.json`. It's plain JSON, it's yours, and it's git-ignorable.

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
- **Hands-free** — turn it on and just talk. IAE listens continuously and works
  out your turns by itself.

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
nodes when Archie commits them. You don't act on ghosts; they're IAE thinking
along with you, and they're the fastest way to tell whether you've been
understood.

### Interrupting

`⌘.` stops Archie mid-sentence and interrupts the reply in flight. Holding
`Space` does the same the moment you start talking. If Archie is still thinking
when you cut in, the reply that was on its way stays silent rather than talking
over you.

---

## 4. The map

### Reading it

A node is a **disc**. Inside: a kind glyph, the label, and the file count.
Underneath, in a caption: what it does, and for a node with children, its
children's names.

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

- **Hover a builder** for its task, its current activity, and a quiet **Stop**.
- **Click one** to fly to where it's working.
- A builder that needs permission shows a **pill on the map** with the actual
  command. **✓** allows, **✗** denies. It appears where the work is happening,
  not in a queue somewhere.
- When a file under a node changes, that node gets one soft ring in the
  builder's colour. It never loops or nags.
- Run several at once — up to 8, 3 by default.

While they work, Archie keeps talking to you. That's the point: you are never
sitting watching a progress bar.

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

This is the thing to remember: IAE doesn't replace Claude Code, it gives it a
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
| **Autonomy** | See below. |
| **Builders at once** | 1–8, default 3. |

### Autonomy — the setting that changes how IAE feels

| Mode | |
|---|---|
| **Ask first** | Builders ask before they change a file or run a command. |
| **Edit files freely** *(default)* | Builders change files on their own, and ask before running a command. |
| **Full autonomy** | Builders never stop to ask. Best on a branch you can throw away. |

If you find yourself approving the same pill over and over, this is the knob —
Archie can't approve on your behalf, and will tell you so.

### Voice settings

Toggle **Speak replies** and **Hands-free voice** from `⌘K` directly. Speech
rate and the preferred system voice are stored too.

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
  whole turn-taking design assumes voice. Install a premium voice first.
- **Answer the card and move on.** Archie's questions always carry a
  recommended default — taking it is usually right, and you can revisit.
- **Delegate early and keep talking.** The design assumes a builder is running
  while you settle the next decision. If you're watching a build, you're using
  it wrong.
- **Use `⌘M` on unfamiliar code.** Meaning mode over a fresh repo is the
  fastest orientation available.
- **Let the map be your file tree.** Looking for something? Find the node that
  owns it and dive. It's faster than searching, and you learn the system.
- **Turn autonomy up on a throwaway branch.** Full autonomy with 3+ builders is
  a different experience, and safe when the branch is disposable.
