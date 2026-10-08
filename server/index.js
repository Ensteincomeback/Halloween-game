// HTTP server: JSON API + static client. No dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, GameError } from './game.js';
import { createStore } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seasonFile = process.env.SEASON || path.join(root, 'season', 'halloween-2026.json');
const dataFile = process.env.DATA_FILE || path.join(root, 'data', 'state.json');
const port = Number(process.env.PORT) || 3000;

const season = JSON.parse(fs.readFileSync(seasonFile, 'utf8'));
const store = createStore(dataFile);
const game = createGame({ season, state: store.state, onChange: store.changed });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const publicDir = path.join(root, 'public');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) reject(new GameError('Body too large', 413));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new GameError('Bad JSON'));
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Light per-IP rate limit, the first line of the anti-bot stack.
const hits = new Map();
function rateLimited(ip) {
  const t = Date.now();
  const h = hits.get(ip) || { start: t, n: 0 };
  if (t - h.start > 10_000) {
    h.start = t;
    h.n = 0;
  }
  h.n += 1;
  hits.set(ip, h);
  return h.n > 60;
}

const routes = {
  'POST /api/login': (_, body) => game.login(body.name),
  'GET /api/me': (tok) => game.me(tok),
  'GET /api/world': () => game.worldView(),
  'GET /api/catalog': () => game.catalog(),
  'GET /api/leaderboard': () => game.leaderboards(),
  'GET /api/feed': () => game.feed(),
  'POST /api/knock': (tok, body) => game.knock(tok, Number(body.houseId), body.gesture),
  'POST /api/scare': (tok, body) => game.resolveScare(tok, body.id),
  'POST /api/ambush': (tok, body) => game.resolveAmbush(tok, body.id, body.counter),
  'POST /api/bank': (tok) => game.bank(tok),
  'POST /api/buy': (tok, body) => game.buy(tok, body.kind, body.itemId),
  'POST /api/equip': (tok, body) => game.equip(tok, body.costumeId),
  'POST /api/mission': (tok, body) => game.claimMission(tok, body.missionId),
};

async function handleApi(req, res, url) {
  if (rateLimited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many requests' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const houseMatch = url.pathname.match(/^\/api\/house\/(\d+)$/);
  try {
    if (req.method === 'GET' && houseMatch) return send(res, 200, game.house(Number(houseMatch[1])));
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, handler(token, body));
  } catch (err) {
    if (err instanceof GameError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
}

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(res, url);
});

server.listen(port, () => {
  console.log(`🎃 Knock is running at http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
