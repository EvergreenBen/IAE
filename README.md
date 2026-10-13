# Arxitect

You architect and Claude builds.

Arxitect is a desktop app built on Claude Code. You don't get panels, file trees or a
wall of terminal text. You get one living architecture map of your system, a
small companion named **Archie** who talks the design through with you out
loud, and a crew of Claude Code builders you can watch at work on the parts of
the map they're changing.

- **Talk, and the map follows.** Likely components sketch themselves while you
  speak (architecture autocomplete). Archie commits them, asks the one question
  that matters, and sends builders off.
- **Never idle.** Builders work in the background while Archie uses the time to
  settle your next real decision. Questions appear *on the node they're about*.
- **Know where everything lives.** Files sit inside the nodes that own them. To
  change your `.env`, open API, then Config, and it's there.
- **Still Claude Code.** Your skills, plugins, CLAUDE.md, MCP servers and slash
  commands all work. Arxitect changes how it feels to use, not what it can do.

## Run it

```bash
npm install
npm run dev            # the desktop app
```

You need Claude Code installed and signed in (`claude` works in your terminal),
or `ANTHROPIC_API_KEY` set.

Voice is optional. Hold **Space** to talk, or switch on hands-free from ⌘K.
Speech-to-text (Whisper) and Archie's voice (Kokoro) both run on-device. They
download on first use, or ahead of time with `npm run voice:setup`.

`npm run web` runs the interface in a browser against a simulated engine, which
is useful for design work. `npm run package` builds a standalone `Arxitect.app`
(unsigned) into `release/`.

To hand Arxitect to someone who won't build it, run `npm run dist`. It writes
`release/Arxitect-<version>-arm64.dmg` (and a `.zip`). Send it with
[`docs/INSTALL.md`](docs/INSTALL.md).

To try it on an existing codebase, open `examples/recipe-box`, a small demo
monorepo. Then follow [`docs/DEMO.md`](docs/DEMO.md).

## Learn more

- [`docs/GUIDE.md`](docs/GUIDE.md): everything Arxitect can do, and how to use it
- [`docs/DEMO.md`](docs/DEMO.md): a five-minute demo
- [`CLAUDE.md`](CLAUDE.md): working on Arxitect
- [`docs/PRD.md`](docs/PRD.md): the brief and how Arxitect adapts it
- [`docs/DESIGN.md`](docs/DESIGN.md): the design language
- [`docs/CONVERSATION.md`](docs/CONVERSATION.md): how Archie thinks and talks
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): how Arxitect is built
