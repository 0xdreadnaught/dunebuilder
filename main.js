const { app, BrowserWindow, ipcMain, clipboard, Menu, shell, dialog, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

// --- Update check config ---
const GITHUB_REPO = '0xdreadnaught/dunebuilder';
const CURRENT_VERSION = require('./package.json').version;

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const useCompact = workAreaSize.height < 1080;

  const win = new BrowserWindow({
    width: useCompact ? 1180 : 1020,
    height: useCompact ? Math.min(860, workAreaSize.height - 80) : 1050,
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
  win.loadFile('index.html', useCompact ? { search: 'compact=1' } : {});
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

  // --- Builds directory ---
  const buildsDir = path.join(app.getPath('appData'), 'DuneBuilder', 'builds');
  fs.mkdirSync(buildsDir, { recursive: true });

  ipcMain.handle('builds:dir', () => buildsDir);

  ipcMain.handle('builds:list', () => {
    try {
      const files = fs.readdirSync(buildsDir).filter(f => f.endsWith('.dbf'));
      return files.map(f => {
        const filepath = path.join(buildsDir, f);
        const stat = fs.statSync(filepath);
        return { name: f.replace(/\.dbf$/, ''), path: filepath, modified: stat.mtimeMs };
      }).sort((a, b) => b.modified - a.modified);
    } catch { return []; }
  });

  ipcMain.handle('builds:load', (_, filepath) => {
    try {
      return fs.readFileSync(filepath, 'utf-8');
    } catch { return null; }
  });

  ipcMain.handle('builds:delete', async (_, filepath) => {
    try {
      await fs.promises.unlink(filepath);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('builds:save', async (_, filepath, data) => {
    try {
      await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
      await fs.promises.writeFile(filepath, data, 'utf-8');
      return true;
    } catch { return false; }
  });

  ipcMain.handle('builds:saveDialog', async (_, defaultName) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save Build',
      defaultPath: path.join(buildsDir, defaultName || 'build.dbf'),
      filters: [{ name: 'DuneBuilder Files', extensions: ['dbf'] }],
    });
    if (canceled || !filePath) return null;
    return filePath.endsWith('.dbf') ? filePath : filePath + '.dbf';
  });

  ipcMain.handle('builds:loadDialog', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Load Build',
      defaultPath: buildsDir,
      filters: [{ name: 'DuneBuilder Files', extensions: ['dbf'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths?.length) return null;
    return filePaths[0];
  });

  // --- Engine.ini (Dune Awakening) ---
  const localAppData = process.env.LOCALAPPDATA
    || path.join(require('node:os').homedir(), 'AppData', 'Local');
  const engineIniPath = path.join(
    localAppData, 'DuneSandbox', 'Saved', 'Config', 'WindowsClient', 'Engine.ini'
  );

  ipcMain.handle('engineIni:read', () => {
    try {
      const text = fs.readFileSync(engineIniPath, 'utf-8');
      return { path: engineIniPath, exists: true, text };
    } catch (err) {
      return { path: engineIniPath, exists: false, text: null };
    }
  });

  ipcMain.handle('engineIni:write', async (_, text) => {
    try {
      await fs.promises.mkdir(path.dirname(engineIniPath), { recursive: true });
      await fs.promises.writeFile(engineIniPath, text, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('engineIni:reveal', () => {
    try {
      shell.showItemInFolder(engineIniPath);
      return true;
    } catch { return false; }
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
