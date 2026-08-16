// 五子棋 · 联机对战服务端
// 纯 Node 内置模块实现：HTTP 静态托管 + 手写 WebSocket（RFC6455），无第三方依赖。
// 运行：node server.js   （可用 PORT 环境变量指定端口，默认 3000）

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SIZE = 15;
const EMPTY = 0, BLACK = 1, WHITE = 2;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

const ROOMS = new Map(); // roomId -> room

function createBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
}

function checkWin(b, r, c, p) {
  for (const [dr, dc] of DIRS) {
    let cnt = 1;
    for (let s = 1; s < 5; s++) { const nr = r + dr * s, nc = c + dc * s; if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && b[nr][nc] === p) cnt++; else break; }
    for (let s = 1; s < 5; s++) { const nr = r - dr * s, nc = c - dc * s; if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && b[nr][nc] === p) cnt++; else break; }
    if (cnt >= 5) return true;
  }
  return false;
}

/* ---------------- HTTP 静态托管 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ALLOWED = new Set(['/index.html', '/multiplayer.html']);

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/' || url === '') url = '/index.html';
  if (url === '/multi') url = '/multiplayer.html';
  if (!ALLOWED.has(url)) { res.writeHead(404); res.end('Not Found'); return; }
  const file = path.join(__dirname, url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket ---------------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  handleSocket(socket);
});

function handleSocket(socket) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = parseFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.total);
      if (frame.opcode === 0x8) { socket.end(); return; }      // close
      if (frame.opcode === 0x9) { sendRaw(socket, 0xA, frame.payload); continue; } // ping -> pong
      if (frame.opcode === 0x1) handleMessage(socket, frame.payload.toString('utf8'));
    }
  });
  socket.on('close', () => onDisconnect(socket));
  socket.on('error', () => {});
}

// 解析客户端发来的（已掩码的）帧
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = buf.readUInt32BE(6); offset = 10; }
  let maskKey;
  if (masked) { if (buf.length < offset + 4) return null; maskKey = buf.slice(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]; }
  return { opcode, payload, total: offset + len };
}

// 服务端 -> 客户端（不加掩码）
function sendRaw(socket, opcode, dataBuf) {
  const len = dataBuf.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  try { socket.write(Buffer.concat([header, dataBuf])); } catch (e) {}
}

function send(socket, obj) {
  sendRaw(socket, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function broadcast(room, obj) {
  for (const p of room.players) send(p.socket, obj);
}

/* ---------------- 房间 / 消息逻辑 ---------------- */
function onJoin(socket, msg) {
  const roomId = String(msg.room || 'lobby').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'lobby';
  let room = ROOMS.get(roomId);
  if (!room) {
    room = { id: roomId, players: [], board: createBoard(), current: BLACK, gameOver: false, winner: null, moves: 0 };
    ROOMS.set(roomId, room);
  }
  if (room.players.length >= 2) { send(socket, { type: 'error', msg: '房间已满（最多 2 人）' }); return; }
  const color = room.players.length === 0 ? BLACK : WHITE;
  const player = { socket, color, name: String(msg.name || (color === BLACK ? '黑方' : '白方')).slice(0, 16), roomId };
  socket.player = player;
  room.players.push(player);
  send(socket, { type: 'joined', color, room: roomId, count: room.players.length });
  if (room.players.length === 2) {
    // 黑方先手
    room.current = BLACK;
    for (const p of room.players) {
      send(p.socket, { type: 'start', you: p.color, first: BLACK, names: room.players.map(x => x.name) });
    }
  }
}

function handleMessage(socket, text) {
  let msg; try { msg = JSON.parse(text); } catch (e) { return; }
  if (msg.type === 'join') return onJoin(socket, msg);
  const p = socket.player;
  if (!p) return;
  const room = ROOMS.get(p.roomId);
  if (!room) return;

  if (msg.type === 'move') {
    if (room.gameOver || room.current !== p.color) return;
    const r = msg.r | 0, c = msg.c | 0;
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE || room.board[r][c] !== EMPTY) return;
    room.board[r][c] = p.color;
    room.moves++;
    if (checkWin(room.board, r, c, p.color)) { room.gameOver = true; room.winner = p.color; }
    else if (room.moves >= SIZE * SIZE) { room.gameOver = true; room.winner = 0; }
    else room.current = p.color === BLACK ? WHITE : BLACK;
    broadcast(room, { type: 'move', r, c, player: p.color, current: room.current, gameOver: room.gameOver, winner: room.winner });
  } else if (msg.type === 'restart') {
    room.board = createBoard(); room.current = BLACK; room.gameOver = false; room.winner = null; room.moves = 0;
    broadcast(room, { type: 'restart', first: BLACK });
  } else if (msg.type === 'chat') {
    broadcast(room, { type: 'chat', from: p.name, text: String(msg.text || '').slice(0, 200) });
  }
}

function onDisconnect(socket) {
  const p = socket.player;
  if (!p) return;
  const room = ROOMS.get(p.roomId);
  if (!room) return;
  room.players = room.players.filter(x => x !== p);
  if (room.players.length > 0) broadcast(room, { type: 'opponent_left' });
  else ROOMS.delete(p.roomId);
}

server.listen(PORT, () => {
  console.log('五子棋联机服务已启动: http://localhost:' + PORT + '  (多人入口: /multi)');
});
