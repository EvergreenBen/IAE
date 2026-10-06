import { app, BrowserWindow, dialog, session, shell, systemPreferences } from 'electron';
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

app.on('before-quit', () => {
  void engine.shutdown();
});
