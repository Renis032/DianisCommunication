const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('dianis', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  getStatus: () => ipcRenderer.invoke('status:get'),
  onStatus: (cb) => subscribe('status', cb),

  listGifs: () => ipcRenderer.invoke('gifs:list'),
  readGif: (id) => ipcRenderer.invoke('gifs:read', id),
  pickGifs: () => ipcRenderer.invoke('gifs:pick'),
  importFiles: (files) =>
    ipcRenderer.invoke(
      'gifs:import',
      [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)
    ),
  deleteGif: (id) => ipcRenderer.invoke('gifs:delete', id),
  restoreBuiltin: () => ipcRenderer.invoke('gifs:restoreBuiltin'),
  onGifsChanged: (cb) => subscribe('gifs:changed', cb),

  send: (payload) => ipcRenderer.invoke('message:send', payload),
  preview: (payload) => ipcRenderer.invoke('message:preview', payload),

  onOverlayShow: (cb) => subscribe('overlay:show', cb),
  overlayInteractive: (on) => ipcRenderer.send('overlay:interactive', on),
  overlayDone: () => ipcRenderer.send('overlay:done'),
  overlayReply: () => ipcRenderer.send('overlay:reply'),
  overlaySave: (id) => ipcRenderer.invoke('overlay:save', id),
});
