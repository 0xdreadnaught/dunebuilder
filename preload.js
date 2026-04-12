const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  openExternal: (url) => ipcRenderer.invoke('update:open', url),
  // Builds
  getBuildsDir: () => ipcRenderer.invoke('builds:dir'),
  listBuilds: () => ipcRenderer.invoke('builds:list'),
  loadBuildFile: (filepath) => ipcRenderer.invoke('builds:load', filepath),
  deleteBuildFile: (filepath) => ipcRenderer.invoke('builds:delete', filepath),
  saveBuildFile: (filepath, data) => ipcRenderer.invoke('builds:save', filepath, data),
  saveDialog: (defaultName) => ipcRenderer.invoke('builds:saveDialog', defaultName),
  loadDialog: () => ipcRenderer.invoke('builds:loadDialog'),
});
