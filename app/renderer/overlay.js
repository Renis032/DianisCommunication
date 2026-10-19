const card = document.getElementById('card');
const bubble = document.querySelector('.bubble');
const fromEl = document.getElementById('from');
const textEl = document.getElementById('text');
const canvas = document.getElementById('gif');
const saveBtn = document.getElementById('save');
const player = new GifPlayer(canvas);

let current = null;
let hideTimer = null;
let hovering = false;

function displayTime(text) {
  const byText = 3500 + (text || '').length * 70;
  const byGif = player.totalDuration() * 2;
  return Math.min(25000, Math.max(7000, byText, byGif));
}

function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!hovering) dismiss();
  }, ms);
}

function dismiss() {
  if (!current) return;
  clearTimeout(hideTimer);
  current = null;
  hovering = false;
  window.dianis.overlayInteractive(false);
  card.classList.add('hidden');
  setTimeout(() => {
    player.dispose();
    window.dianis.overlayDone();
  }, 380);
}

window.dianis.onOverlayShow(async (msg) => {
  current = msg;
  fromEl.textContent = msg.from || '';
  textEl.textContent = msg.text || '';
  bubble.classList.toggle('empty', !msg.text);
  saveBtn.hidden = !msg.canSave;
  saveBtn.textContent = 'Save GIF';
  try {
    await player.load(msg.bytes, msg.mime, { maxSize: 280 });
  } catch (err) {
    console.error('Could not decode GIF', err);
  }
  requestAnimationFrame(() => card.classList.remove('hidden'));
  scheduleHide(displayTime(msg.text));
});

card.addEventListener('mouseenter', () => {
  hovering = true;
  window.dianis.overlayInteractive(true);
  clearTimeout(hideTimer);
});

card.addEventListener('mouseleave', () => {
  hovering = false;
  window.dianis.overlayInteractive(false);
  if (current) scheduleHide(2500);
});

document.getElementById('close').addEventListener('click', dismiss);

document.getElementById('reply').addEventListener('click', () => {
  window.dianis.overlayReply();
  dismiss();
});

saveBtn.addEventListener('click', async () => {
  if (!current) return;
  const ok = await window.dianis.overlaySave(current.id);
  saveBtn.textContent = ok ? 'Saved ♥' : 'Could not save';
});
