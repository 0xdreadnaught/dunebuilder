const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setWindowWidthScale: (scale) => ipcRenderer.invoke('window:setWidthScale', scale),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  getVersion: () => ipcRenderer.invoke('app:version'),
  // Updates
  onUpdateAvailable:  (cb) => ipcRenderer.on('update:available', (_, data) => cb(data)),
  onDownloadProgress: (cb) => ipcRenderer.on('update:progress', (_, pct) => cb(pct)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, data) => cb(data)),
  onUpdateError:      (cb) => ipcRenderer.on('update:error', (_, msg) => cb(msg)),
  downloadUpdate:     ()   => ipcRenderer.invoke('update:download'),
  installUpdate:      ()   => ipcRenderer.invoke('update:install'),
  // Builds
  listBuilds: () => ipcRenderer.invoke('builds:list'),
  loadBuildFile: (filepath) => ipcRenderer.invoke('builds:load', filepath),
  deleteBuildFile: (filepath) => ipcRenderer.invoke('builds:delete', filepath),
  saveBuildFile: (filepath, data) => ipcRenderer.invoke('builds:save', filepath, data),
  saveDialog: (defaultName) => ipcRenderer.invoke('builds:saveDialog', defaultName),
  loadDialog: () => ipcRenderer.invoke('builds:loadDialog'),
  // Engine.ini
  engineIni: {
    read:   ()     => ipcRenderer.invoke('engineIni:read'),
    write:  (text) => ipcRenderer.invoke('engineIni:write', text),
    reveal: ()     => ipcRenderer.invoke('engineIni:reveal'),
  },
});
