// A deliberately small app menu. Electron's default menu claims ⌘M (minimize)
// and ⌘0 (actual size), which Arxitect uses for meaning mode and fit-to-scope, so
// those accelerators are left free here. The Edit menu is required on macOS
// for copy/paste/undo to work in text fields.
import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export function installMenu(): void {
  const isMac = process.platform === 'darwin';
  const dev = !app.isPackaged;
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(dev ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'close' }, { role: 'zoom' }, ...(isMac ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : [])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
