import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const W = new PublicKey('AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU');
import { RPC_URL } from './rpc.mjs';
const c = new Connection(RPC_URL, 'confirmed');
const bal = await c.getBalance(W);
console.log('余额:', (bal / 1e9).toFixed(6), 'SOL');
for (const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
  const r = await c.getParsedTokenAccountsByOwner(W, { programId: new PublicKey(prog) });
  for (const a of r.value) {
    const i = a.account.data.parsed.info;
    console.log('持仓:', i.mint, Number(i.tokenAmount.uiAmount).toLocaleString(), '枚 | ATA', a.pubkey.toBase58().slice(0, 8), '| 租金', (a.account.lamports / 1e9).toFixed(6));
  }
}
const sigs = await c.getSignaturesForAddress(W, { limit: 20 });
console.log('\n最近交易:');
for (const s of sigs) {
  const t = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
  const d = t ? ((t.meta.postBalances[0] - t.meta.preBalances[0]) / 1e9).toFixed(6) : '?';
  console.log(' ', new Date(s.blockTime * 1000).toLocaleTimeString('zh-CN', { hour12: false }), (s.err ? '❌失败' : '✅成功'), 'ΔSOL', d, 'fee', t ? (t.meta.fee / 1e9).toFixed(6) : '?');
}
