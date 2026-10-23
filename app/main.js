const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  screen,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const { autoUpdater } = require('electron-updater');

const GIF_TYPES = {
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.apng': 'image/apng',
};
const MAX_GIF_BYTES = 12 * 1024 * 1024;
const OVERLAY_W = 380;
const OVERLAY_H = 560;
const HISTORY_LIMIT = 10;
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

const BUILTIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'gifs')
  : path.join(__dirname, 'gifs');
const MY_DIR = () => path.join(app.getPath('userData'), 'my-gifs');
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const HISTORY_DIR = () => path.join(app.getPath('userData'), 'history');
const HISTORY_PATH = () => path.join(HISTORY_DIR(), 'history.json');
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

let config = {
  serverUrl: '',
  room: '',
  name: '',
  autostart: true,
  hiddenBuiltin: [],
  favourites: [],
};
let history = [];
let updateState = { ready: false, version: null };
let composer = null;
let overlay = null;
let overlayReady = null;
let tray = null;
let quitting = false;

if (process.platform === 'win32') app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => showComposer());

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) };
  } catch {}
  if (!Array.isArray(config.hiddenBuiltin)) config.hiddenBuiltin = [];
  if (!Array.isArray(config.favourites)) config.favourites = [];
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}

function isConfigured() {
  return !!(config.serverUrl && config.room && config.name);
}

function listDir(dir, source) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => GIF_TYPES[path.extname(f).toLowerCase()])
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({
        id: `${source}:${f}`,
        name: path.parse(f).name,
        source,
        url: pathToFileURL(path.join(dir, f)).href,
      }));
  } catch {
    return [];
  }
}

function resolveGif(id) {
  const [source, ...rest] = String(id).split(':');
  const file = path.basename(rest.join(':'));
  const dir = source === 'builtin' ? BUILTIN_DIR : source === 'mine' ? MY_DIR() : null;
  if (!dir || !file) throw new Error('Unknown GIF');
  const full = path.join(dir, file);
  const mime = GIF_TYPES[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('Unsupported file type');
  return { full, mime, name: path.parse(file).name };
}

function uniqueTarget(dir, fileName) {
  const { name, ext } = path.parse(fileName);
  const safe = name.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 60) || 'gif';
  let candidate = path.join(dir, `${safe}${ext.toLowerCase()}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safe} (${n++})${ext.toLowerCase()}`);
  }
  return candidate;
}

function importGifs(paths) {
  fs.mkdirSync(MY_DIR(), { recursive: true });
  const errors = [];
  let added = 0;
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    if (!GIF_TYPES[ext]) {
      errors.push(`${path.basename(p)}: not a GIF/WebP/PNG`);
      continue;
    }
    if (fs.statSync(p).size > MAX_GIF_BYTES) {
      errors.push(`${path.basename(p)}: larger than 12 MB`);
      continue;
    }
    fs.copyFileSync(p, uniqueTarget(MY_DIR(), path.basename(p)));
    added++;
  }
  notifyGifsChanged();
  return { added, errors };
}

function notifyGifsChanged() {
  if (composer && !composer.isDestroyed()) composer.webContents.send('gifs:changed');
}

function setFavourite(id, on) {
  const list = config.favourites.filter((f) => f !== id);
  if (on) list.unshift(id);
  config.favourites = list;
  saveConfig();
  notifyGifsChanged();
}

function extFor(mime) {
  return Object.keys(GIF_TYPES).find((k) => GIF_TYPES[k] === mime) || '.gif';
}

function loadHistory() {
  try {
    const list = JSON.parse(fs.readFileSync(HISTORY_PATH(), 'utf8'));
    if (Array.isArray(list)) {
      history = list.filter((h) => h && h.file && fs.existsSync(path.join(HISTORY_DIR(), h.file)));
    }
  } catch {}
}

function saveHistory() {
  fs.mkdirSync(HISTORY_DIR(), { recursive: true });
  fs.writeFileSync(HISTORY_PATH(), JSON.stringify(history, null, 2));
}

function notifyHistoryChanged() {
  if (composer && !composer.isDestroyed()) composer.webContents.send('history:changed');
}

function addToHistory(item) {
  if (history.some((h) => h.id === item.id)) return;
  try {
    fs.mkdirSync(HISTORY_DIR(), { recursive: true });
    const file = `${crypto.randomUUID()}${extFor(item.mime)}`;
    fs.writeFileSync(path.join(HISTORY_DIR(), file), item.bytes);
    history.unshift({
      id: item.id,
      from: item.from,
      text: item.text,
      mime: item.mime,
      gifName: item.gifName,
      time: Date.now(),
      file,
    });
    for (const old of history.splice(HISTORY_LIMIT)) {
      try {
        fs.unlinkSync(path.join(HISTORY_DIR(), old.file));
      } catch {}
    }
    saveHistory();
    notifyHistoryChanged();
  } catch (err) {
    console.error('Could not store history', err);
  }
}

function getReceived(id) {
  if (recentReceived.has(id)) return recentReceived.get(id);
  const entry = history.find((h) => h.id === id);
  if (!entry) return null;
  try {
    return { ...entry, bytes: fs.readFileSync(path.join(HISTORY_DIR(), entry.file)) };
  } catch {
    return null;
  }
}

// Copies a received GIF into My GIFs (once per history entry) and returns its GIF id.
function saveReceived(id) {
  const entry = history.find((h) => h.id === id);
  if (entry && entry.savedAs && fs.existsSync(path.join(MY_DIR(), entry.savedAs))) {
    return `mine:${entry.savedAs}`;
  }
  const item = getReceived(id);
  if (!item) return null;
  fs.mkdirSync(MY_DIR(), { recursive: true });
  const base = `${item.gifName || 'from ' + item.from}${extFor(item.mime)}`;
  const file = path.basename(uniqueTarget(MY_DIR(), base));
  fs.writeFileSync(path.join(MY_DIR(), file), item.bytes);
  if (entry) {
    entry.savedAs = file;
    saveHistory();
    notifyHistoryChanged();
  }
  notifyGifsChanged();
  return `mine:${file}`;
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => console.error('Update failed:', err && err.message));
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { ready: true, version: info.version };
    if (composer && !composer.isDestroyed()) composer.webContents.send('update', updateState);
    updateTray();
    // The app lives in the tray and rarely quits, so install on its own once nobody is using it.
    clearInterval(idleInstallTimer);
    idleInstallTimer = setInterval(() => {
      if (isIdle()) installUpdate(false);
    }, 60 * 1000);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_MS);
}

let idleInstallTimer = null;

function isIdle() {
  const composerInUse =
    composer && !composer.isDestroyed() && composer.isVisible() && !composer.isMinimized();
  return !composerInUse && !overlayBusy && !overlayQueue.length && !pendingAcks.size;
}

function installUpdate(openAfter) {
  if (!updateState.ready) return;
  config.openAfterUpdate = !!openAfter;
  saveConfig();
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
}

let ws = null;
let wsGeneration = 0;
let reconnectTimer = null;
let pingTimer = null;
let retryDelay = 1000;
let status = { connected: false, peerOnline: false, peerName: null, error: null };
const pendingAcks = new Map();
const recentReceived = new Map();

function setStatus(patch) {
  status = { ...status, ...patch };
  if (composer && !composer.isDestroyed()) composer.webContents.send('status', status);
  updateTray();
}

function normalizeUrl(url) {
  const u = url.trim().replace(/\/+$/, '');
  if (/^https:\/\//i.test(u)) return u.replace(/^https:/i, 'wss:');
  if (/^http:\/\//i.test(u)) return u.replace(/^http:/i, 'ws:');
  if (/^wss?:\/\//i.test(u)) return u;
  return `wss://${u}`;
}

function disconnect() {
  wsGeneration++;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.on('error', () => {});
    try {
      ws.terminate();
    } catch {}
    ws = null;
  }
}

function connect() {
  disconnect();
  if (!isConfigured()) {
    setStatus({ connected: false, peerOnline: false, error: 'Open settings to connect' });
    return;
  }
  const gen = wsGeneration;
  let socket;
  try {
    socket = new WebSocket(normalizeUrl(config.serverUrl), { maxPayload: 20 * 1024 * 1024 });
  } catch (err) {
    setStatus({ connected: false, error: err.message });
    return;
  }
  ws = socket;

  socket.on('open', () => {
    if (gen !== wsGeneration) return;
    retryDelay = 1000;
    socket.send(JSON.stringify({ t: 'hello', room: config.room, name: config.name }));
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' }));
    }, 25000);
  });

  socket.on('message', (raw) => {
    if (gen !== wsGeneration) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  socket.on('error', (err) => {
    if (gen !== wsGeneration) return;
    setStatus({ error: err.message });
  });

  socket.on('close', () => {
    if (gen !== wsGeneration) return;
    clearInterval(pingTimer);
    setStatus({ connected: false, peerOnline: false });
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });
}

function handleServerMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      setStatus({ connected: true, error: null });
      break;
    case 'peer':
      setStatus({ peerOnline: !!msg.online, peerName: msg.name || status.peerName });
      break;
    case 'error':
      setStatus({ error: msg.error });
      break;
    case 'ack': {
      const pending = pendingAcks.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAcks.delete(msg.id);
        pending.resolve({ ok: true, status: msg.status });
      }
      break;
    }
    case 'msg':
      receiveMessage(msg);
      break;
  }
}

function receiveMessage(msg) {
  const bytes = Buffer.from(msg.gif || '', 'base64');
  if (!bytes.length) return;
  const item = {
    id: msg.id || crypto.randomUUID(),
    from: msg.from,
    text: msg.text,
    mime: msg.mime,
    gifName: msg.gifName,
    bytes,
  };
  recentReceived.set(item.id, item);
  while (recentReceived.size > 20) recentReceived.delete(recentReceived.keys().next().value);
  addToHistory(item);
  enqueueOverlay(item);
}

function sendMessage({ gifId, text }) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !status.connected) {
      resolve({ ok: false, error: 'Not connected to the server' });
      return;
    }
    let gif;
    try {
      gif = resolveGif(gifId);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const bytes = fs.readFileSync(gif.full);
    if (bytes.length > MAX_GIF_BYTES) {
      resolve({ ok: false, error: 'GIF is larger than 12 MB' });
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingAcks.delete(id);
      resolve({ ok: false, error: 'Server did not confirm the message' });
    }, 30000);
    pendingAcks.set(id, { resolve, timer });
    ws.send(
      JSON.stringify({
        t: 'msg',
        id,
        text: String(text || '').slice(0, 500),
        gif: bytes.toString('base64'),
        mime: gif.mime,
        gifName: gif.name,
      })
    );
  });
}

const overlayQueue = [];
let overlayBusy = false;

function createOverlay() {
  overlay = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlayReady = new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
}

function positionOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  overlay.setBounds({
    x: Math.round(workArea.x + workArea.width - OVERLAY_W - 12),
    y: Math.round(workArea.y + workArea.height - OVERLAY_H - 4),
    width: OVERLAY_W,
    height: OVERLAY_H,
  });
}

function enqueueOverlay(item) {
  overlayQueue.push(item);
  pumpOverlay();
}

async function pumpOverlay() {
  if (overlayBusy || !overlayQueue.length) return;
  overlayBusy = true;
  const item = overlayQueue.shift();
  await overlayReady;
  positionOverlay();
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.webContents.send('overlay:show', {
    id: item.id,
    from: item.from,
    text: item.text,
    mime: item.mime,
    canSave: !item.preview,
    bytes: new Uint8Array(item.bytes),
  });
}

function updateTray() {
  if (!tray) return;
  const label = !status.connected
    ? 'Disconnected'
    : status.peerOnline
      ? `${status.peerName || 'Partner'} is online`
      : 'Connected, partner offline';
  tray.setToolTip(`Dianis - ${label}`);
  const updateItems = updateState.ready
    ? [{ label: `Restart to update (v${updateState.version})`, click: () => installUpdate(true) }]
    : [];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Send a GIF…', click: showComposer },
      { label: 'Reconnect', click: connect },
      ...updateItems,
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', showComposer);
  updateTray();
}

function showComposer() {
  if (composer && !composer.isDestroyed()) {
    if (composer.isMinimized()) composer.restore();
    composer.show();
    composer.focus();
    return;
  }
  composer = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 520,
    minHeight: 480,
    title: 'Dianis',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: '#fff7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  composer.setMenuBarVisibility(false);
  composer.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      composer.hide();
    }
  });
  composer.loadFile(path.join(__dirname, 'renderer', 'composer.html'));
}

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!config.autostart, args: ['--hidden'] });
}

ipcMain.handle('config:get', () => ({ ...config }));
ipcMain.handle('config:set', (_e, next) => {
  config = {
    ...config,
    serverUrl: String(next.serverUrl || '').trim(),
    room: String(next.room || '').trim(),
    name: String(next.name || '').trim(),
    autostart: !!next.autostart,
  };
  saveConfig();
  applyAutostart();
  connect();
  return { ...config };
});
ipcMain.handle('status:get', () => status);
ipcMain.handle('gifs:list', () => {
  const all = listDir(BUILTIN_DIR, 'builtin');
  const hidden = new Set(config.hiddenBuiltin);
  const builtin = all.filter((g) => !hidden.has(g.id));
  const mine = listDir(MY_DIR(), 'mine');
  const byId = new Map([...builtin, ...mine].map((g) => [g.id, g]));
  return {
    favourites: config.favourites.map((id) => byId.get(id)).filter(Boolean),
    builtin,
    hiddenBuiltinCount: all.length - builtin.length,
    mine,
  };
});
ipcMain.handle('gifs:favourite', (_e, id, on) => {
  resolveGif(id);
  setFavourite(id, !!on);
  return true;
});
ipcMain.handle('gifs:read', (_e, id) => {
  const gif = resolveGif(id);
  return { bytes: new Uint8Array(fs.readFileSync(gif.full)), mime: gif.mime };
});
ipcMain.handle('gifs:pick', async () => {
  const res = await dialog.showOpenDialog(composer, {
    title: 'Add your own GIFs',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Animated images', extensions: ['gif', 'webp', 'png', 'apng'] }],
  });
  if (res.canceled) return { added: 0, errors: [] };
  return importGifs(res.filePaths);
});
ipcMain.handle('gifs:import', (_e, paths) => importGifs(Array.isArray(paths) ? paths : []));
ipcMain.handle('gifs:delete', (_e, id) => {
  const gif = resolveGif(id);
  if (id.startsWith('builtin:')) {
    if (!config.hiddenBuiltin.includes(id)) config.hiddenBuiltin.push(id);
    saveConfig();
  } else {
    fs.unlinkSync(gif.full);
  }
  config.favourites = config.favourites.filter((f) => f !== id);
  saveConfig();
  notifyGifsChanged();
  return true;
});
ipcMain.handle('gifs:restoreBuiltin', () => {
  config.hiddenBuiltin = [];
  saveConfig();
  notifyGifsChanged();
  return true;
});
ipcMain.handle('message:send', (_e, payload) => sendMessage(payload));
ipcMain.handle('message:preview', (_e, { gifId, text }) => {
  const gif = resolveGif(gifId);
  enqueueOverlay({
    id: crypto.randomUUID(),
    from: config.name || 'You',
    text,
    mime: gif.mime,
    preview: true,
    bytes: fs.readFileSync(gif.full),
  });
  return true;
});

ipcMain.on('overlay:interactive', (_e, on) => {
  if (overlay) overlay.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on('overlay:done', () => {
  overlayBusy = false;
  if (overlayQueue.length) {
    pumpOverlay();
  } else if (overlay) {
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.hide();
  }
});
ipcMain.on('overlay:reply', () => showComposer());
ipcMain.handle('overlay:save', (_e, id) => !!saveReceived(id));

ipcMain.handle('history:list', () =>
  history.map((h) => ({
    id: h.id,
    from: h.from,
    text: h.text,
    time: h.time,
    gifName: h.gifName,
    saved: !!(h.savedAs && fs.existsSync(path.join(MY_DIR(), h.savedAs))),
    favourite: !!h.savedAs && config.favourites.includes(`mine:${h.savedAs}`),
    url: pathToFileURL(path.join(HISTORY_DIR(), h.file)).href,
  }))
);
ipcMain.handle('history:replay', (_e, id) => {
  const item = getReceived(id);
  if (!item) return false;
  enqueueOverlay(item);
  return true;
});
ipcMain.handle('history:save', (_e, id) => !!saveReceived(id));
ipcMain.handle('history:favourite', (_e, id) => {
  const gifId = saveReceived(id);
  if (!gifId) return false;
  setFavourite(gifId, true);
  notifyHistoryChanged();
  return true;
});

ipcMain.handle('update:get', () => ({ ...updateState, current: app.getVersion() }));
ipcMain.on('update:install', () => installUpdate(true));

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.dianis.communication');
  loadConfig();
  loadHistory();
  applyAutostart();
  createOverlay();
  createTray();
  connect();
  // After an update the installer restarts us with --updated: stay in the tray unless the
  // user asked for the restart themselves.
  const afterQuietUpdate = process.argv.includes('--updated') && !config.openAfterUpdate;
  if (config.openAfterUpdate) {
    config.openAfterUpdate = false;
    saveConfig();
  }
  const startHidden = (process.argv.includes('--hidden') || afterQuietUpdate) && isConfigured();
  if (!startHidden) showComposer();
  setupAutoUpdate();
});
