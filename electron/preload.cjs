const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bitblade", {
  isElectron: true,
  platform: process.platform,
  startHost: () => ipcRenderer.invoke("bb:startHost"),
  stopHost: () => ipcRenderer.invoke("bb:stopHost"),
  startTunnel: () => ipcRenderer.invoke("bb:startTunnel"),
  stopTunnel: () => ipcRenderer.invoke("bb:stopTunnel"),
  toggleFullscreen: () => ipcRenderer.invoke("bb:toggleFullscreen"),
});
