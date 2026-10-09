// Real Solana wallets in the browser, without any npm packages.
//
// Wallets are found through the Wallet Standard (the same discovery the official
// wallet-adapter uses: Phantom, Solflare, Backpack, and others register
// themselves), with a fallback for wallets that only inject `window.phantom` /
// `window.solflare` / `window.backpack`. The wallet is asked to connect, to sign
// the plain-text sign-in message, and to sign transactions the game server
// built (deposits, moving an NFT into escrow). The wallet never sends anything
// itself: the server checks the signed bytes are exactly what it built, then sends.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

// ---------- Wallet Standard discovery ----------
const standard = [];
const listeners = new Set();
const registry = {
  register(...wallets) {
    for (const w of wallets) if (!standard.includes(w)) standard.push(w);
    listeners.forEach((fn) => fn());
    return () => {};
  },
};
window.addEventListener('wallet-standard:register-wallet', (e) => {
  try {
    e.detail(registry);
  } catch {}
});
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));

export const onWalletsChanged = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const isSolanaStandard = (w) => w.chains?.some((c) => c.startsWith('solana:')) && w.features?.['standard:connect'] && w.features?.['solana:signMessage'];

function legacyProviders() {
  const out = [];
  const add = (name, provider, icon) => provider && out.push({ name, icon, legacy: provider });
  add('Phantom', window.phantom?.solana?.isPhantom && window.phantom.solana);
  add('Solflare', window.solflare?.isSolflare && window.solflare);
  add('Backpack', window.backpack?.isBackpack && window.backpack);
  return out;
}

// Every wallet we can talk to, standard ones first, one entry per name.
export function listWallets() {
  const seen = new Set();
  const out = [];
  for (const w of standard.filter(isSolanaStandard)) {
    if (seen.has(w.name)) continue;
    seen.add(w.name);
    out.push({ name: w.name, icon: w.icon, standard: w });
  }
  for (const w of legacyProviders()) {
    if (seen.has(w.name)) continue;
    seen.add(w.name);
    out.push(w);
  }
  return out;
}

// Links shown when no wallet is installed.
export const INSTALL_LINKS = [
  ['Phantom', 'https://phantom.com/download'],
  ['Solflare', 'https://solflare.com/download'],
  ['Backpack', 'https://backpack.app/download'],
];

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));

// Connect and return { name, address, signMessage(text) → Uint8Array,
// signTransaction(base64, cluster) → base64, disconnect(), onChange(fn) }.
export async function connectWallet(entry) {
  if (entry.standard) {
    const w = entry.standard;
    const { accounts } = await w.features['standard:connect'].connect();
    const account = accounts?.find((a) => a.chains?.some((c) => c.startsWith('solana:')) ?? true) || accounts?.[0];
    if (!account) throw new Error('The wallet did not share an account');
    return {
      name: w.name,
      address: account.address,
      async signMessage(text) {
        const [out] = await w.features['solana:signMessage'].signMessage({ account, message: new TextEncoder().encode(text) });
        return out.signature;
      },
      async signTransaction(b64, cluster) {
        const f = w.features['solana:signTransaction'];
        if (!f) throw new Error(`${w.name} can't sign transactions here. Try Phantom, Solflare or Backpack.`);
        const chain = `solana:${cluster}`;
        const [out] = await f.signTransaction({ account, transaction: b64ToBytes(b64), ...(w.chains?.includes(chain) ? { chain } : {}) });
        return bytesToB64(out.signedTransaction);
      },
      async disconnect() {
        await w.features['standard:disconnect']?.disconnect().catch(() => {});
      },
      onChange(fn) {
        return w.features['standard:events']?.on('change', fn) || (() => {});
      },
    };
  }
  const p = entry.legacy;
  const res = await p.connect();
  const pk = res?.publicKey || p.publicKey;
  if (!pk) throw new Error('The wallet did not share an account');
  return {
    name: entry.name,
    address: pk.toBase58 ? pk.toBase58() : String(pk),
    async signMessage(text) {
      const out = await p.signMessage(new TextEncoder().encode(text), 'utf8');
      return out.signature || out;
    },
    async signTransaction() {
      throw new Error(`Update ${entry.name}: signing game transactions needs a wallet that supports the Wallet Standard.`);
    },
    async disconnect() {
      await p.disconnect?.().catch(() => {});
    },
    onChange(fn) {
      p.on?.('accountChanged', fn);
      return () => p.off?.('accountChanged', fn);
    },
  };
}

// Read-only: the wallet's SOL balance from the cluster's public RPC.
export async function getSolBalance(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address, { commitment: 'confirmed' }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result.value / 1e9;
}

export const explorerUrl = (address, cluster) => (cluster === 'localnet' ? null : `https://explorer.solana.com/address/${address}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`);
