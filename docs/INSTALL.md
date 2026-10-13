# Installing Arxitect

For Macs with Apple Silicon (M1 or later).

## 1. Install

1. Open `Arxitect-<version>-arm64.dmg`.
2. Drag **Arxitect** into **Applications**.

## 2. Open it the first time

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

## 3. Sign in to Claude

Arxitect runs on Claude Code and uses your Claude account (Pro or Max), so the
work it does counts toward your plan's usage.

**If `claude` already works in your Terminal**, you're done.

**If not**, sign in once with the copy of Claude Code that ships inside the
app:

```bash
/Applications/Arxitect.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
```

Type `/login`, finish signing in in your browser, then type `/exit`. Reopen
Arxitect.

## 4. Good to have

- **git**: builders use it. If `git --version` asks you to install developer
  tools, say yes.
- **Node.js** (nodejs.org) if you'll build JavaScript projects.
- **Voice**: the first time you hold Space, Arxitect downloads its speech
  models (a few hundred MB) and asks for the microphone.

Read [`GUIDE.md`](GUIDE.md) for how to use it.
