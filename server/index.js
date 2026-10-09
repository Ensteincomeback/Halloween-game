// HTTP server: JSON API + static client.
//
// CHAIN=sim (default)  simulated chain, no dependencies
// CHAIN=solana         real Solana (devnet by default); run `npm run solana:setup` first
// CHAIN=local          real Solana programs in-process (LiteSVM); a fresh chain every start

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, GameError } from './game.js';
import { ChainError } from './chain.js';
import { loadSeason } from './config.js';
import { createStore } from './store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seasonFile = process.env.SEASON || path.join(root, 'season', 'halloween-2026.json');
const CHAIN = String(process.env.CHAIN || 'sim').trim().toLowerCase();
if (!['sim', 'solana', 'local'].includes(CHAIN)) throw new Error(`CHAIN must be sim, solana or local (got "${CHAIN}")`);
// Each chain mode keeps its own save file: game state points at real accounts.
const dataFile = process.env.DATA_FILE || path.join(root, 'data', CHAIN === 'sim' ? 'state.json' : `state-${CHAIN}.json`);
const port = Number(process.env.PORT) || 3000;
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

const season = loadSeason(seasonFile);
// The local chain lives in memory, so its game state can't outlive it.
if (CHAIN === 'local' && fs.existsSync(dataFile)) fs.rmSync(dataFile);
const store = createStore(dataFile);
// Dev build: `npm run dev`, `node server/index.js --dev`, or DEV=1. On Windows,
// `set DEV=1 && node ...` stores "1 " with a trailing space, so trim it.
const DEV = process.argv.includes('--dev') || ['1', 'true', 'yes', 'on'].includes(String(process.env.DEV ?? '').trim().toLowerCase());
// Which Solana cluster player wallets sign in for, and the RPC the client reads balances from.
const solanaConfigFile = path.join(root, 'data', 'solana.json');
const solanaConfig = CHAIN === 'solana' && fs.existsSync(solanaConfigFile) ? JSON.parse(fs.readFileSync(solanaConfigFile, 'utf8')) : {};
const SOLANA_CLUSTER = CHAIN === 'local' ? 'localnet' : process.env.SOLANA_CLUSTER || solanaConfig.cluster || 'devnet';
const SOLANA_RPC = CHAIN === 'local' ? null : process.env.SOLANA_RPC || solanaConfig.rpcUrl || `https://api.${SOLANA_CLUSTER}.solana.com`;

// Real-Solana modes load the bridge (and its npm packages) only when asked for.
let onchain = null;
if (CHAIN !== 'sim') {
  const { installBridge } = await import('./onchain/bridge.js');
  const { loadOrCreateKeys, setupChain } = await import('./onchain/setup.js');
  const conn = await (async () => {
    const mod = await import('./onchain/connection.js');
    if (CHAIN === 'solana') return mod.createRpcConnection(SOLANA_RPC);
    const { LiteSVM } = await import('litesvm');
    return mod.createLiteSvmConnection(new LiteSVM());
  })();
  const keys = loadOrCreateKeys(path.join(root, 'data', CHAIN === 'solana' ? 'solana-keys.json' : 'local-keys.json'));
  let booMint = solanaConfig.booMint;
  if (CHAIN === 'local') {
    await conn.airdrop(keys.authority.publicKey, 1_000 * 1e9);
    ({ booMint } = await setupChain(conn, { ...keys, supply: season.token.totalSupply, publicUrl }));
  } else if (!booMint) {
    console.error('No $BOO mint yet. Run `npm run solana:setup` first (it creates data/solana.json).');
    process.exit(1);
  }
  onchain = { install: installBridge, conn, ...keys, booMint, publicUrl };
}

const game = createGame({ season, state: store.state, onChange: store.changed, dev: DEV, solana: { cluster: SOLANA_CLUSTER, rpcUrl: SOLANA_RPC }, onchain });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary' };
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
  'POST /api/login': (_, b, req) => game.login(b.name, req.socket.remoteAddress),
  'POST /api/wallet/challenge': (_, b, req) => game.walletChallenge(b.address, req.headers.host),
  'POST /api/wallet/verify': (t, b, req) => game.walletVerify(t, { nonce: b.nonce, signature: b.signature, walletName: b.walletName, name: b.name }, req.socket.remoteAddress),
  'POST /api/wallet/unlink': (t) => game.walletUnlink(t),
  'GET /api/me': (t) => game.me(t),
  'GET /api/world': (t) => game.world(t),
  'GET /api/catalog': () => game.catalog(),
  'GET /api/leaderboard': (t, b, req, url) => game.leaderboards(url.searchParams.get('division') || 'all'),
  'GET /api/feed': () => game.feed(),
  'GET /api/market': () => game.market(),
  'GET /api/economy': () => game.economy(),
  'GET /api/chain': () => game.chain(),
  'POST /api/knock': (t, b) => game.knock(t, b.houseId, b.gesture),
  'POST /api/scare': (t, b) => game.resolveScare(t, b.id),
  'POST /api/ambush': (t, b) => game.resolveAmbush(t, b.id, b.counter, b.bribe),
  'POST /api/bank': (t, b) => game.bank(t, b.pos),
  'POST /api/buy': (t, b) => game.buy(t, b.kind, b.itemId),
  'POST /api/equip': (t, b) => game.equip(t, b.costumeId),
  'POST /api/train': (t, b) => game.train(t, b.stat),
  'POST /api/unlock': (t, b) => game.unlock(t, b.neighborhood, b.pos),
  'POST /api/raffle': (t, b) => game.raffle(t, b.slots, b.free),
  'POST /api/raffle/claim': (t, b) => game.claimRafflePrize(t, b.id, b.details),
  'GET /api/auctions': (t) => game.auctions(t),
  'POST /api/auction/create': (t, b) => game.createAuction(t, { item: b.item, slotPrice: b.slotPrice, maxSlots: b.maxSlots, minutes: b.minutes }),
  'POST /api/auction/enter': (t, b) => game.enterAuction(t, b.id, b.slots),
  'POST /api/auction/cancel': (t, b) => game.cancelAuction(t, b.id),
  'POST /api/sol-faucet': (t) => game.solFaucet(t),
  // Real Solana (CHAIN=solana / local)
  'GET /api/onchain': (t) => game.onchain(t),
  'GET /api/onchain/report': () => game.onchainReport(),
  'POST /api/onchain/deposit': (t, b) => game.deposit(t, b.currency, b.amount),
  'POST /api/onchain/withdraw': (t, b) => game.withdraw(t, b.currency, b.amount),
  'POST /api/onchain/submit': (t, b) => game.submitIntent(t, b.intent, b.transaction),
  'POST /api/onchain/airdrop': (t, b) => game.airdrop(t, b.sol),
  'GET /api/token/boo.json': () => game.tokenMetadata(),
  'POST /api/craft': (t, b) => game.craft(t, b.cardId),
  'POST /api/mint-card': (t, b) => game.mintCard(t, b.cardId),
  'POST /api/prize': (t, b) => game.redeemPrize(t, b.prizeId),
  'POST /api/npc/accept': (t, b) => game.acceptMission(t, b.giver, b.pos),
  'POST /api/npc/claim': (t, b) => game.claimMission(t, b.giver, b.pos),
  'POST /api/claim': (t) => game.claimBoo(t),
  'POST /api/faucet': (t) => game.faucet(t),
  'POST /api/deed/buy': (t, b) => game.buyDeed(t, b.houseId),
  'POST /api/deed/dial': (t, b) => game.setDial(t, b.houseId, b.mode),
  'POST /api/deed/lantern': (t, b) => game.buyLantern(t, b.houseId),
  'POST /api/deed/till': (t, b) => game.claimTill(t, b.houseId),
  'POST /api/market/list': (t, b) => game.listHouse(t, b.houseId, b.price),
  'POST /api/market/cancel': (t, b) => game.cancelListing(t, b.houseId),
  'POST /api/market/buy': (t, b) => game.buyListing(t, b.houseId),
  'POST /api/monster/stake': (t, b) => game.stake(t, b.amount),
  'POST /api/monster/unstake': (t, b) => game.unstake(t, b.amount),
  'POST /api/monster/become': (t, b) => game.becomeMonster(t, b.type),
  'POST /api/monster/lair': (t, b) => game.setLair(t, b.houseId, b.kind),
  'POST /api/monster/claim': (t) => game.claimMonsterBoo(t),
  'POST /api/bounty': (t, b) => game.postBounty(t, b.monster, b.amount),
};

// Dev build: /api/dev/<action> with { args: [...] } calls game.dev[action](token, ...args).
if (DEV) {
  for (const name of Object.keys(game.dev)) routes[`POST /api/dev/${name}`] = (t, b) => game.dev[name](t, ...(Array.isArray(b.args) ? b.args : []));
}

async function handleApi(req, res, url) {
  if (rateLimited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many requests' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const houseMatch = url.pathname.match(/^\/api\/house\/(\d+)$/);
  try {
    if (req.method === 'GET' && houseMatch) return send(res, 200, game.house(houseMatch[1], token));
    const nftMatch = url.pathname.match(/^\/api\/nft\/([\w-]+)\.json$/);
    if (req.method === 'GET' && nftMatch) return send(res, 200, game.nftMetadata(nftMatch[1]));
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await handler(token, body, req, url));
  } catch (err) {
    if (err instanceof GameError || err instanceof ChainError) return send(res, err.status, { error: err.message });
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

// The world clock runs even when nobody is polling: the Legendary Mansion
// schedule, Town Raffle draws and player raffles all settle here.
setInterval(() => {
  try {
    game.tick();
  } catch (err) {
    console.error(err);
  }
}, 2000).unref();

server.listen(port, () => {
  console.log(`🎃 Knock is running at http://localhost:${port}${DEV ? '  [DEV BUILD: dev panel enabled]' : ''}`);
});

// Real Solana: the outbox worker sends withdrawals, NFT mints and deliveries,
// and burns; ownership is re-synced with the chain every 30 seconds.
if (onchain) {
  const ctx = game._ctx;
  const safely = (fn) => () => fn().catch((err) => console.error('[onchain]', err.message));
  await safely(ctx.reconcileOnchain)();
  setInterval(safely(ctx.processOutbox), 3000).unref();
  setInterval(safely(ctx.syncNftOwners), 30_000).unref();
  console.log(`⛓  ${CHAIN === 'local' ? 'Local Solana chain (LiteSVM, in memory)' : `Solana ${SOLANA_CLUSTER} via ${SOLANA_RPC}`} · $${season.token.symbol} mint ${onchain.booMint} · vault ${ctx.onchainKeys.vault}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
