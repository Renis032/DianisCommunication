const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const MAX_QUEUED_PER_ROOM = 30;
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_ROOMS = (process.env.ROOMS || '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { clients: new Set(), queue: [] };
    rooms.set(code, room);
  }
  return room;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function peersOf(room, ws) {
  return [...room.clients].filter((c) => c !== ws && c.name !== ws.name);
}

function broadcastPresence(room) {
  for (const c of room.clients) {
    const peers = peersOf(room, c);
    send(c, { t: 'peer', online: peers.length > 0, name: peers[0] ? peers[0].name : null });
  }
}

function flushQueue(room, ws) {
  const now = Date.now();
  room.queue = room.queue.filter((q) => now - q.ts < QUEUE_TTL_MS);
  const mine = room.queue.filter((q) => q.from !== ws.name);
  room.queue = room.queue.filter((q) => q.from === ws.name);
  for (const q of mine) send(ws, q);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Dianis relay is running\n');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.name = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === 'ping') {
      send(ws, { t: 'pong' });
      return;
    }

    if (msg.t === 'hello') {
      const code = String(msg.room || '').trim();
      const name = String(msg.name || '').trim().slice(0, 40);
      if (code.length < 6 || !name) {
        send(ws, { t: 'error', error: 'Room code must be at least 6 characters and a name is required.' });
        ws.close();
        return;
      }
      if (ALLOWED_ROOMS.length && !ALLOWED_ROOMS.includes(code)) {
        send(ws, { t: 'error', error: 'Unknown room code.' });
        ws.close();
        return;
      }
      if (ws.room) ws.room.clients.delete(ws);
      ws.name = name;
      ws.room = getRoom(code);
      for (const c of ws.room.clients) {
        if (c.name === name) c.close(4000, 'Replaced by a newer connection');
      }
      ws.room.clients.add(ws);
      send(ws, { t: 'welcome' });
      flushQueue(ws.room, ws);
      broadcastPresence(ws.room);
      return;
    }

    if (msg.t === 'msg' && ws.room) {
      const out = {
        t: 'msg',
        id: String(msg.id || ''),
        from: ws.name,
        ts: Date.now(),
        text: String(msg.text || '').slice(0, 500),
        gif: String(msg.gif || ''),
        mime: String(msg.mime || 'image/gif'),
        gifName: String(msg.gifName || '').slice(0, 120),
      };
      const peers = peersOf(ws.room, ws);
      if (peers.length) {
        for (const p of peers) send(p, out);
        send(ws, { t: 'ack', id: out.id, status: 'delivered' });
      } else {
        ws.room.queue.push(out);
        if (ws.room.queue.length > MAX_QUEUED_PER_ROOM) ws.room.queue.shift();
        send(ws, { t: 'ack', id: out.id, status: 'queued' });
      }
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    ws.room.clients.delete(ws);
    broadcastPresence(ws.room);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Dianis relay listening on port ${PORT}`);
});
