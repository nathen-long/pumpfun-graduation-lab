import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const W = new PublicKey('AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU');
import { RPCS as RPCS_LOCAL } from './rpc.mjs';
const RPCS = RPCS_LOCAL;
for (const url of RPCS) {
  try {
    const c = new Connection(url, 'confirmed');
    const bal = await c.getBalance(W);
    console.log('[' + url.split('//')[1].slice(0, 18) + '] 余额', (bal / 1e9).toFixed(6), 'SOL');
    let total = 0;
    for (const p of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
      const r = await c.getParsedTokenAccountsByOwner(W, { programId: new PublicKey(p) });
      for (const a of r.value) {
        const i = a.account.data.parsed.info;
        const n = Number(i.tokenAmount.uiAmount);
        if (n > 0) { console.log('  持仓', i.mint, n.toLocaleString(), '枚 | 租金', (a.account.lamports / 1e9).toFixed(6)); total++; }
      }
    }
    console.log('  有余额的代币账户数:', total);
    break;
  } catch (e) { console.log('  失败:', String(e.message).slice(0, 80)); }
}
