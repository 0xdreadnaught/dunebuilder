const { app, BrowserWindow, ipcMain, clipboard, Menu, shell } = require('electron');
const path = require('node:path');
const https = require('node:https');

// --- Update check config ---
const GITHUB_REPO = '0xdreadnaught/dunebuilder';
const CURRENT_VERSION = require('./package.json').version;

function createWindow() {
  const win = new BrowserWindow({
    width: 1020,
    height: 1025,
    resizable: false,
    icon: path.join(__dirname, 'dunebuilder_logo_512.png'),
    backgroundColor: '#0d0b08',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('clipboard:read', () => {
    return clipboard.readText();
  });

  ipcMain.handle('clipboard:write', (_, text) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('update:check', () => checkForUpdate());

  ipcMain.handle('update:open', (_, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return;
      shell.openExternal(url);
    } catch { /* invalid URL, ignore */ }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function checkForUpdate() {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      headers: { 'User-Agent': `DuneBuilder/${CURRENT_VERSION}` },
    };
    https.get(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const latest = (data.tag_name || '').replace(/^v/, '');
          if (!latest) return resolve(null);
          if (compareVersions(latest, CURRENT_VERSION) > 0) {
            resolve({
              version: latest,
              url: data.html_url,
              notes: data.body || '',
            });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
