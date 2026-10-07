# PRD: the CEC project brief, and how Arxitect adapts it

## Original PRD (summarised faithfully)

**Problem.** Independent developers lose time to idle waits while AI tools work,
and they lose focus by context switching (phones, reels) between prompts. Many
also don't understand their own system architecture well enough, which hurts
their performance.

**Audience.** Independent software developers.

**Current workarounds.** Running many Claude or Devin agents in parallel until
the developer is overwhelmed, which still doesn't remove idle time. Code
understanding gets outsourced to separate tools (DeepWiki, Code Atlas).

**Why now.** Live conversational models make smooth human–agent dialogue
practical. Vibe coding has made developers skip architecture entirely.

**Cost of doing nothing.** Hours lost to context switching. Developers who
can't debug their own code. Tooling that raises agent throughput while ignoring
the human.

**Features (as written).**

- *Main panel.* A team-leader icon pulses at the side as the main conversational
  partner. It opens and creates projects on command. Inside a project, a system
  architecture diagram is drawn dynamically and keeps changing as the
  conversation goes. This is the home screen of every project. Clicking figures
  shows relevant files, and clicking a file shows the code. New figures appear
  in real time with every word, like autocomplete, so **idle time is killed**.
- *File system visualiser.* Called up on command. It toggles between the raw
  files and a summary of what every file and folder means.
- *Mockups panel.* Sits between the application and the diagram, showing rough
  versions of the team's plans.
- *Agent team.* Led by a Team Leader (names customisable) who keeps a constant,
  natural dialogue going. A team is created behind the scenes when a project
  starts (agents can also be added manually), and tasks are delegated
  continuously.
- *Team leader.* Engages in meaningful conversation and **never stops talking
  to the user while the session is going**, constantly helping them find new
  ideas and ways to execute.
- *Agent team visualiser.* Engaging visuals of every agent and what it's working
  on (see octogent, fig. 1).

## Arxitect's adaptations (decided with the product owner)

| PRD | Arxitect | Why |
|---|---|---|
| "IDE" | **Arxitect** | People architect and ideate. Claude develops. |
| Main panel + side panels | **One full-bleed map, no panels** | Panels turn into an IDE. The map is the interface. |
| Pulsating leader icon | **Archie**, a small original character whose *expressions* show listening, thinking, speaking, or "has a question" | A pulsing orb reads as AI slop. Intentional states read as a partner. |
| File system visualiser | **Files live inside the nodes that own them.** Dive in to find them. ⌘M (meaning mode) swaps names for meanings. | You learn where things live by going there. No file tree. |
| Mockups panel | **Deferred.** A future "sketch" lens can open on client nodes. | Minimal first, then add. |
| Separate agent visualiser (octogent) | **Agents live on the map**, standing on the node they're working in and gliding as they move | You see *what* and *where* together, inside the architecture. |
| "Never stops talking" | **Never idle, never chatter.** A pulse surfaces the next decision when it clears the quality bar. Silence is allowed. | Constant talk is noise. Constant *momentum* is the goal. |
| Predictive dialogue | **Architecture autocomplete**: ghost nodes sketch what you're saying as you say it | "Every word moves the map." |
| (implicit) new platform | **Built on Claude Code** through the Agent SDK: your skills, plugins, CLAUDE.md, MCP and slash commands still work | Keep everything great about Claude Code. Change only how it feels to use. |

## Success

The win condition: a developer who lives in Claude Code in a terminal would
rather use Arxitect. It is demoable, fun, and faster for real work. Concretely:

- An empty folder becomes a sketched architecture within a minute of talking.
- An existing repo has a credible map within about a minute of opening, and you
  can find `.env` through the map in three clicks.
- While builders work, the user is engaged by real decisions, not by waiting.
- Nothing on screen feels like an IDE, a dashboard, or a chat app.
