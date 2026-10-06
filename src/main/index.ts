import { app, BrowserWindow, dialog, session, shell, systemPreferences } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptLoginShellPath } from './env';
import { registerIpc, windowEmitter } from './ipc';
import { installMenu } from './menu';
import { Engine, type EngineHost } from './engine/engine';

const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

adoptLoginShellPath();
app.setName('IAE');

// Packaged builds: Claude Code's native binary is unpacked next to the asar
// archive (see electron-builder.yml). Point the Agent SDK at it.
if (app.isPackaged && !process.env.IAE_CLAUDE_PATH) {
  const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (existsSync(unpacked)) process.env.IAE_CLAUDE_PATH = unpacked;
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
};
const engine = new Engine(emit, host);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'IAE',
    backgroundColor: '#F5F3EE',
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
    // than letting them run (and spend) invisibly until the Dock reopens Home.
    void engine.closeProject().catch(() => {});
  });
  // A reload (dev) returns the renderer to Home, so the engine follows.
  let loadedOnce = false;
  win.webContents.on('did-finish-load', () => {
    if (loadedOnce) void engine.closeProject().catch(() => {});
    loadedOnce = true;
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Wait for the engine to flush .iae/ writes and stop sessions before exiting.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.quit();
  void Promise.race([engine.shutdown(), new Promise((r) => setTimeout(r, 4000))]).then(done, done);
});
