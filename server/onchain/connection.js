// One small interface over two backends:
//   - a real Solana RPC (devnet, testnet, mainnet), used by `CHAIN=solana`
//   - LiteSVM, an in-process Solana runtime (real programs, real signatures),
//     used by the tests and by `CHAIN=local` (a dev dependency, loaded on demand)
// Everything the bridge needs goes through here, so the game logic never cares
// which one it's talking to.

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { unpackAccount, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { base58Encode } from '../solana.js';

export class ChainTxError extends Error {
  constructor(message, logs = []) {
    super(message);
    this.logs = logs;
  }
}

export function createRpcConnection(rpcUrl, { commitment = 'confirmed' } = {}) {
  const conn = new Connection(rpcUrl, commitment);
  return {
    kind: 'rpc',
    rpcUrl,
    async blockhash() {
      return conn.getLatestBlockhash(commitment);
    },
    // Send wire-format bytes and wait for confirmation. Returns the signature.
    async send(bytes, { blockhash, lastValidBlockHeight } = {}) {
      const sig = await conn.sendRawTransaction(bytes, { skipPreflight: false, preflightCommitment: commitment });
      const bh = blockhash ? { blockhash, lastValidBlockHeight } : await conn.getLatestBlockhash(commitment);
      const res = await conn.confirmTransaction({ signature: sig, ...bh }, commitment);
      if (res.value.err) throw new ChainTxError(`Transaction failed: ${JSON.stringify(res.value.err)}`);
      return sig;
    },
    // 'confirmed' | 'failed' | 'unknown' (not seen, e.g. dropped)
    async status(sig) {
      const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = value[0];
      if (!s) return 'unknown';
      if (s.err) return 'failed';
      return s.confirmationStatus === 'processed' ? 'unknown' : 'confirmed';
    },
    async blockhashValid(blockhash) {
      return (await conn.isBlockhashValid(blockhash, { commitment })).value;
    },
    async lamports(pubkey) {
      return conn.getBalance(new PublicKey(pubkey), commitment);
    },
    async exists(pubkey) {
      return !!(await conn.getAccountInfo(new PublicKey(pubkey), commitment));
    },
    async rentExempt(size) {
      return conn.getMinimumBalanceForRentExemption(size, commitment);
    },
    // Token amount held in a token account (0 if it doesn't exist).
    async tokenAmount(ata, programId = TOKEN_2022_PROGRAM_ID) {
      const info = await conn.getAccountInfo(new PublicKey(ata), commitment);
      if (!info) return 0n;
      return unpackAccount(new PublicKey(ata), info, programId).amount;
    },
    // Who holds an NFT right now (the owner of the token account with amount 1).
    async nftHolder(mint, _candidates, programId = TOKEN_2022_PROGRAM_ID) {
      const { value } = await conn.getTokenLargestAccounts(new PublicKey(mint), commitment);
      const top = value.find((a) => a.amount === '1');
      if (!top) return null;
      const info = await conn.getAccountInfo(top.address, commitment);
      return info ? unpackAccount(top.address, info, programId).owner.toBase58() : null;
    },
    async airdrop(pubkey, lamports) {
      const sig = await conn.requestAirdrop(new PublicKey(pubkey), lamports);
      const bh = await conn.getLatestBlockhash(commitment);
      await conn.confirmTransaction({ signature: sig, ...bh }, commitment);
      return sig;
    },
  };
}

// LiteSVM 1.x speaks @solana/kit (string addresses, bigint lamports); the game
// hands it the same wire-format bytes it would send to a real RPC.
export async function createLiteSvmConnection(svm) {
  const kit = await import('@solana/kit');
  const decoder = kit.getTransactionDecoder();
  const addr = (pk) => kit.address(typeof pk === 'string' ? pk : pk.toBase58());
  const seen = new Map(); // signature -> 'confirmed' | 'failed'
  // getAccount() returns { exists, ... }; getProgramAccounts() entries have no `exists` flag.
  const toInfo = (acc) => (acc && acc.exists !== false && acc.data ? { data: Buffer.from(acc.data), owner: new PublicKey(acc.programAddress), lamports: Number(acc.lamports), executable: acc.executable } : null);
  return {
    kind: 'litesvm',
    svm,
    async blockhash() {
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0 };
    },
    async send(bytes) {
      const sig = base58Encode(VersionedTransaction.deserialize(bytes).signatures[0]);
      const r = svm.sendTransaction(decoder.decode(bytes));
      if (r.constructor.name !== 'TransactionMetadata') {
        seen.set(sig, 'failed');
        let logs = [];
        try {
          logs = r.meta().logs();
        } catch {}
        throw new ChainTxError(`Transaction failed: ${String(r.err?.())}`, logs);
      }
      seen.set(sig, 'confirmed');
      return sig;
    },
    async status(sig) {
      return seen.get(sig) || 'unknown';
    },
    async blockhashValid(blockhash) {
      return blockhash === svm.latestBlockhash();
    },
    async lamports(pubkey) {
      return Number(svm.getBalance(addr(pubkey)) || 0n);
    },
    async exists(pubkey) {
      return !!svm.getAccount(addr(pubkey))?.exists;
    },
    async rentExempt(size) {
      return Number(svm.minimumBalanceForRentExemption(BigInt(size)));
    },
    async tokenAmount(ata, programId = TOKEN_2022_PROGRAM_ID) {
      const info = toInfo(svm.getAccount(addr(ata)));
      return info ? unpackAccount(new PublicKey(ata), info, programId).amount : 0n;
    },
    // Scan the token program's accounts for the one holding this NFT.
    async nftHolder(mint, _candidates, programId = TOKEN_2022_PROGRAM_ID) {
      for (const acc of svm.getProgramAccounts(addr(programId))) {
        const info = toInfo(acc);
        let tok;
        try {
          tok = unpackAccount(new PublicKey(acc.address), info, programId);
        } catch {
          continue; // a mint, not a token account
        }
        if (tok.mint.toBase58() === String(mint) && tok.amount === 1n) return tok.owner.toBase58();
      }
      return null;
    },
    async airdrop(pubkey, lamports) {
      svm.airdrop(addr(pubkey), kit.lamports(BigInt(lamports)));
    },
  };
}
