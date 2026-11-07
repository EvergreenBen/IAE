# Installing Arxitect

Arxitect runs on a Mac with Apple Silicon (M1 or later) or on 64-bit Windows 10
or 11. It needs one of these accounts:

- **Claude** (Pro or Max), through Claude Code, or
- **ChatGPT** (Plus, Pro, Business…), through Codex.

Both come inside the app, so you don't install anything else to get started.

## Mac

### 1. Install

1. Open `Arxitect-<version>-arm64.dmg`.
2. Drag **Arxitect** into **Applications**.

### 2. Open it the first time

Arxitect isn't from the App Store, so macOS blocks it the first time.

1. Open Arxitect from Applications. macOS says it can't verify it. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to Arxitect.
3. Confirm with your password or Touch ID.

You only do this once. If the button doesn't appear, run this in Terminal and
open the app again:

```bash
xattr -dr com.apple.quarantine /Applications/Arxitect.app
```

## Windows

1. Run `Arxitect-<version>-x64.exe`. Windows says it protected your PC,
   because the installer isn't signed. Click **More info**, then **Run anyway**.
2. Follow the installer. Arxitect opens from the Start menu afterwards.
3. Install **Git for Windows** (git-scm.com) if you don't have it. Claude Code
   needs it on Windows, and builders use git either way.

## Sign in

Arxitect's home screen says at the bottom what it's connected to.

### With ChatGPT (Codex)

1. On the home screen, click **Use Codex instead**. You can also pick
   **Codex** under **Runs on** in Settings (⌘K on a Mac, Ctrl+K on Windows,
   then Settings).
2. Click **Sign in with ChatGPT**. Your browser opens. Sign in and come back.
   The line at the bottom turns to "Connected to Codex".

If you already use Codex in a terminal, Arxitect picks up that sign-in. An
`OPENAI_API_KEY` in your environment also works.

With Codex:

- Builders don't stop to ask before changing files or running commands. They
  work inside a sandbox that only lets them write inside the project folder.
  Use a git repository so every change can be undone.
- Replies come a whole sentence-group at a time instead of word by word, so
  the lead takes a moment longer to start talking.
- Slash commands (`/`) are Claude Code's, so they aren't available.
- **Codex model** in Settings picks the model. Leave it empty for Codex's
  default.

### With Claude (Claude Code)

**If `claude` already works in your terminal**, you're done.

**If not**, sign in once with the copy of Claude Code that ships inside the
app.

On a Mac, in Terminal:

```bash
/Applications/Arxitect.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
```

On Windows, in PowerShell:

```powershell
& "$env:LOCALAPPDATA\Programs\Arxitect\resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe"
```

Type `/login`, finish signing in in your browser, then type `/exit`. Reopen
Arxitect.

The work Arxitect does counts toward your plan's usage, whichever account you
use.

## Good to have

- **git**: builders use it. On a Mac, if `git --version` asks you to install
  developer tools, say yes.
- **Node.js** (nodejs.org) if you'll build JavaScript projects.
- **Voice**: the first time you hold Space, Arxitect downloads its speech
  models (a few hundred MB) and asks for the microphone.

Read [`GUIDE.md`](GUIDE.md) for how to use it.
