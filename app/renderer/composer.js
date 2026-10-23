const api = window.dianis;

const favsGrid = document.getElementById('favs');
const favsEmpty = document.getElementById('favs-empty');
const builtinGrid = document.getElementById('builtin');
const mineGrid = document.getElementById('mine');
const mineEmpty = document.getElementById('mine-empty');
const addTile = document.getElementById('add-gif');
const builtinEmpty = document.getElementById('builtin-empty');
const builtinHidden = document.getElementById('builtin-hidden');
const builtinHiddenText = document.getElementById('builtin-hidden-text');
const previewCanvas = document.getElementById('preview');
const previewEmpty = document.getElementById('preview-empty');
const message = document.getElementById('message');
const count = document.getElementById('count');
const sendBtn = document.getElementById('send-btn');
const previewBtn = document.getElementById('preview-btn');
const toast = document.getElementById('toast');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const settings = document.getElementById('settings');
const drop = document.getElementById('drop');
const search = document.getElementById('search');
const searchCount = document.getElementById('search-count');
const noMatches = document.getElementById('no-matches');

const player = new GifPlayer(previewCanvas);
let selectedId = null;
let selectedBytes = null;
let status = { connected: false };
let toastTimer = null;
let sending = false;
let favIds = new Set();

function showToast(text, isError = false) {
  toast.textContent = text;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

function renderStatus(s) {
  status = s;
  statusEl.classList.toggle('connected', !!s.connected);
  statusEl.classList.toggle('online', !!(s.connected && s.peerOnline));
  if (!s.connected) {
    statusText.textContent = s.error ? `Disconnected: ${s.error}` : 'Connecting…';
  } else if (s.peerOnline) {
    statusText.textContent = `${s.peerName || 'Your partner'} is online`;
  } else {
    statusText.textContent = "Connected. They're offline, so messages wait for them";
  }
  updateButtons();
}

function updateButtons() {
  previewBtn.disabled = !selectedId;
  sendBtn.disabled = !selectedId || !status.connected || sending;
}

function makeTile(gif, inFavs = false) {
  const tile = document.createElement('button');
  tile.className = 'tile';
  const label = gif.name.replace(/[-_]+/g, ' ');
  tile.title = label;
  tile.dataset.id = gif.id;
  tile.dataset.search = label.toLowerCase();
  if (gif.id === selectedId) tile.classList.add('selected');
  const img = document.createElement('img');
  img.src = gif.url;
  img.alt = gif.name;
  img.loading = 'lazy';
  tile.appendChild(img);
  const isFav = favIds.has(gif.id);
  const fav = document.createElement('span');
  fav.className = isFav ? 'fav on' : 'fav';
  fav.textContent = isFav ? '★' : '☆';
  fav.title = isFav ? 'Remove from favourites' : 'Add to favourites';
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    api.setFavourite(gif.id, !isFav);
  });
  tile.appendChild(fav);
  tile.addEventListener('click', () => select(gif.id));
  if (inFavs) return tile;
  const builtin = gif.source === 'builtin';
  const del = document.createElement('span');
  del.className = 'del';
  del.textContent = '✕';
  del.title = builtin ? 'Hide this built-in GIF' : 'Remove from my GIFs';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    const question = builtin
      ? `Hide "${gif.name}"? You can bring it back with "Restore".`
      : `Delete "${gif.name}" from your GIFs?`;
    if (!confirm(question)) return;
    await api.deleteGif(gif.id);
    if (selectedId === gif.id) clearSelection();
  });
  tile.appendChild(del);
  return tile;
}

async function refreshGifs() {
  const { favourites, builtin, hiddenBuiltinCount, mine } = await api.listGifs();
  favIds = new Set(favourites.map((g) => g.id));
  favsGrid.replaceChildren(...favourites.map((g) => makeTile(g, true)));
  favsEmpty.hidden = favourites.length > 0;
  builtinGrid.replaceChildren(...builtin.map((g) => makeTile(g)));
  builtinEmpty.hidden = builtin.length > 0 || hiddenBuiltinCount > 0;
  builtinHidden.hidden = !hiddenBuiltinCount;
  builtinHiddenText.textContent = `${hiddenBuiltinCount} hidden.`;
  mineGrid.replaceChildren(...mine.map((g) => makeTile(g)));
  mineEmpty.hidden = mine.length > 0;
  if (selectedId && ![...builtin, ...mine].some((g) => g.id === selectedId)) clearSelection();
  applySearch();
}

function applySearch() {
  const words = search.value.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const tiles = document.querySelectorAll('.tile[data-search]');
  let shown = 0;
  let total = 0;
  tiles.forEach((tile) => {
    const match = words.every((w) => tile.dataset.search.includes(w));
    tile.hidden = !match;
    // Favourites repeat GIFs from the sections below, so don't count them twice.
    if (tile.parentElement === favsGrid) return;
    total++;
    if (match) shown++;
  });
  searchCount.hidden = !words.length;
  searchCount.textContent = `${shown} of ${total}`;
  noMatches.hidden = !words.length || shown > 0;
}

function clearSelection() {
  selectedId = null;
  selectedBytes = null;
  player.dispose();
  previewEmpty.hidden = false;
  updateButtons();
}

async function renderPreview() {
  if (!selectedBytes) return;
  try {
    await player.load(selectedBytes.bytes, selectedBytes.mime, { maxSize: 260 });
    previewEmpty.hidden = true;
  } catch (err) {
    player.dispose();
    previewEmpty.hidden = false;
    showToast(`Could not read this GIF: ${err.message}`, true);
  }
}

async function select(id) {
  selectedId = id;
  document.querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
  document
    .querySelectorAll(`.tile[data-id="${CSS.escape(id)}"]`)
    .forEach((t) => t.classList.add('selected'));
  updateButtons();
  selectedBytes = await api.readGif(id);
  if (selectedId !== id) return;
  await renderPreview();
  message.focus();
}

async function send() {
  if (sendBtn.disabled) return;
  sending = true;
  updateButtons();
  sendBtn.textContent = 'Sending…';
  try {
    const res = await api.send({
      gifId: selectedId,
      text: message.value.trim(),
    });
    if (res.ok) {
      showToast(res.status === 'delivered' ? 'Delivered ♥' : "Sent. They'll see it when they come online ♥");
      message.value = '';
      count.textContent = '0';
    } else {
      showToast(res.error || 'Could not send', true);
    }
  } finally {
    sending = false;
    sendBtn.textContent = 'Send ♥';
    updateButtons();
  }
}

sendBtn.addEventListener('click', send);
search.addEventListener('input', applySearch);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    search.value = '';
    applySearch();
  }
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    search.focus();
    search.select();
  }
});
previewBtn.addEventListener('click', () => {
  if (!selectedId) return;
  api.preview({ gifId: selectedId, text: message.value.trim() });
});
message.addEventListener('input', () => (count.textContent = message.value.length));
message.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});

document.getElementById('restore-builtin').addEventListener('click', () => api.restoreBuiltin());

addTile.addEventListener('click', async () => {
  const res = await api.pickGifs();
  if (res.errors.length) showToast(res.errors.join('\n'), true);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  if (!e.dataTransfer.files.length) return;
  const res = await api.importFiles(e.dataTransfer.files);
  if (res.errors.length) showToast(res.errors.join('\n'), true);
  else if (res.added) showToast(`Added ${res.added} GIF${res.added > 1 ? 's' : ''}`);
});

const cfgName = document.getElementById('cfg-name');
const cfgServer = document.getElementById('cfg-server');
const cfgRoom = document.getElementById('cfg-room');
const cfgAutostart = document.getElementById('cfg-autostart');

async function openSettings() {
  const cfg = await api.getConfig();
  cfgName.value = cfg.name;
  cfgServer.value = cfg.serverUrl;
  cfgRoom.value = cfg.room;
  cfgAutostart.checked = !!cfg.autostart;
  settings.showModal();
}

document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('cancel-settings').addEventListener('click', () => settings.close());
document.getElementById('gen-room').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  cfgRoom.value = [...bytes].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
});
document.getElementById('settings-form').addEventListener('submit', async () => {
  await api.setConfig({
    name: cfgName.value,
    serverUrl: cfgServer.value,
    room: cfgRoom.value,
    autostart: cfgAutostart.checked,
  });
});

const historyDialog = document.getElementById('history');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');

function formatTime(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function makeHistoryRow(h) {
  const row = document.createElement('li');
  row.className = 'history-row';
  row.title = 'Show it again';
  row.addEventListener('click', () => api.replayHistory(h.id));

  const thumb = document.createElement('div');
  thumb.className = 'history-thumb checker';
  const img = document.createElement('img');
  img.src = h.url;
  img.alt = h.gifName || 'GIF';
  thumb.appendChild(img);

  const body = document.createElement('div');
  body.className = 'history-body';
  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const from = document.createElement('strong');
  from.textContent = h.from || 'Unknown';
  const time = document.createElement('span');
  time.textContent = formatTime(h.time);
  meta.append(from, time);
  const text = document.createElement('p');
  text.className = h.text ? 'history-text' : 'history-text none';
  text.textContent = h.text || '(no message)';
  body.append(meta, text);

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  const save = document.createElement('button');
  save.className = 'ghost small';
  save.textContent = h.saved ? 'Saved ✓' : 'Save GIF';
  save.disabled = h.saved;
  save.title = 'Copy it into My GIFs';
  save.addEventListener('click', (e) => {
    e.stopPropagation();
    api.saveHistory(h.id);
  });
  const fav = document.createElement('button');
  fav.className = h.favourite ? 'ghost small fav-btn on' : 'ghost small fav-btn';
  fav.textContent = h.favourite ? '★' : '☆';
  fav.disabled = h.favourite;
  fav.title = h.favourite ? 'In your favourites' : 'Save it and add to favourites';
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    api.favouriteHistory(h.id);
  });
  actions.append(save, fav);

  row.append(thumb, body, actions);
  return row;
}

async function renderHistory() {
  const items = await api.listHistory();
  historyList.replaceChildren(...items.map(makeHistoryRow));
  historyEmpty.hidden = items.length > 0;
}

document.getElementById('open-history').addEventListener('click', async () => {
  await renderHistory();
  historyDialog.showModal();
});
document.getElementById('close-history').addEventListener('click', () => historyDialog.close());
historyDialog.addEventListener('click', (e) => {
  if (e.target !== historyDialog) return;
  const r = historyDialog.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (outside) historyDialog.close();
});

const updateBar = document.getElementById('update-bar');
const updateText = document.getElementById('update-text');

function renderUpdate(u) {
  updateBar.hidden = !u.ready;
  updateText.textContent = `Version ${u.version} is ready. It installs by itself while Dianis sits in the tray, or right now:`;
}

document.getElementById('update-restart').addEventListener('click', () => api.installUpdate());

api.onStatus(renderStatus);
api.onGifsChanged(refreshGifs);
api.onHistoryChanged(() => {
  if (historyDialog.open) renderHistory();
});
api.onUpdate(renderUpdate);

(async () => {
  renderStatus(await api.getStatus());
  const update = await api.getUpdate();
  renderUpdate(update);
  document.getElementById('app-version').textContent = `v${update.current}`;
  await refreshGifs();
  const cfg = await api.getConfig();
  if (!cfg.name || !cfg.serverUrl || !cfg.room) openSettings();
})();
