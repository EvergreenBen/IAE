import { app, BrowserWindow, dialog, session, shell, systemPreferences } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptLoginShellPath } from './env';
import { registerIpc, windowEmitter } from './ipc';
import { installMenu } from './menu';
import { Engine, type EngineHost } from './engine/engine';
import { watchOwnSource } from './selfwatch';

const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
/** scripts/dev.mjs runs the app and starts it again when it exits with this code (rebuilding main on the way). */
const RESTART_CODE = 75;
const supervised = !app.isPackaged && process.env.ARXITECT_SUPERVISOR === '1';

adoptLoginShellPath();
app.setName('Arxitect');
// A separate settings and recent-projects folder: for test runs, or a second copy of the app.
if (process.env.ARXITECT_USER_DATA) app.setPath('userData', process.env.ARXITECT_USER_DATA);
adoptOldUserData();

/**
 * The app used to be called IAE, and Electron derives the userData folder from
 * the name — so settings and the recent-project list would be left behind in
 * the old one. Carry them across the first time.
 *
 * Only our own files move: Chromium has usually created the new folder (for
 * its caches) before this runs, so the folder existing says nothing about
 * whether the settings made it. The old copies are left where they are, so a
 * half-finished move can simply be run again.
 */
function adoptOldUserData(): void {
  const next = app.getPath('userData');
  const prev = join(app.getPath('appData'), 'IAE');
  if (prev === next) return;
  for (const name of ['settings.json', 'recent.json']) {
    try {
      const from = join(prev, name);
      const to = join(next, name);
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(next, { recursive: true });
      copyFileSync(from, to);
    } catch {
      // Starting with defaults beats not starting at all.
    }
  }
}

// Packaged builds: Claude Code's native binary is unpacked next to the asar
// archive (see electron-builder.yml). Point the Agent SDK at it.
if (app.isPackaged && !process.env.ARXITECT_CLAUDE_PATH) {
  const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (existsSync(unpacked)) process.env.ARXITECT_CLAUDE_PATH = unpacked;
}

let win: BrowserWindow | null = null;
const emit = windowEmitter(() => win);

const host: EngineHost = {
  async pickFolder() {
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Open' };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  },
  userDataDir: () => app.getPath('userData'),
  homeDir: () => homedir(),
  revealFile: (absPath) => shell.showItemInFolder(absPath),
  restart() {
    if (supervised) return app.exit(RESTART_CODE);
    app.relaunch();
    app.exit(0);
  },
};
const engine = new Engine(emit, host);

/** Arxitect's own main-process files that changed since launch (only watched when a restart can rebuild them). */
let stale: string[] = [];

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Arxitect',
    backgroundColor: '#1D1F22',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Archie's first spoken reply shouldn't wait for a click.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
    // No window, no audience: stop the lead, builders and watchers rather
    // than letting them run (and spend) invisibly. The project reopens, and
    // its builders resume, when a window comes back.
    void engine.suspend().catch(() => {});
  });
  // A reload (hot reload in dev, ⌘R) keeps the project running: the renderer
  // asks for it again (resume), so builders are never cut off mid-job.
  win.webContents.on('did-finish-load', () => {
    if (stale.length) emit({ type: 'app/stale', files: stale });
  });

  // External links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(here, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // Microphone for voice. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  if (process.platform === 'darwin') {
    void systemPreferences.askForMediaAccess('microphone').catch(() => false);
  }

  installMenu();
  // In dev the Dock shows Electron's icon; give it Archie's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(here, '../../build/icon.png'));
  registerIpc(engine);
  createWindow();
  void engine.boot();
  if (supervised) {
    watchOwnSource(app.getAppPath(), (files) => {
      stale = files;
      emit({ type: 'app/stale', files });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Wait for the engine to flush project-state writes and stop sessions before exiting.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.quit();
  void Promise.race([engine.shutdown(), new Promise((r) => setTimeout(r, 4000))]).then(done, done);
});
