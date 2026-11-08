import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const W = new PublicKey('AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU');
import { RPC_URL } from './rpc.mjs';
const c = new Connection(RPC_URL, 'confirmed');
const sigs = await c.getSignaturesForAddress(W, { limit: 25 });
console.log('时间      状态     ΔSOL       手续费     说明');
let tot = 0;
for (const s of sigs.reverse()) {
  await new Promise(r => setTimeout(r, 220));
  const t = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
  if (!t) { console.log(new Date(s.blockTime * 1000).toLocaleTimeString('zh-CN', { hour12: false }), s.err ? '失败' : '成功', ' (读不到详情)'); continue; }
  const d = (t.meta.postBalances[0] - t.meta.preBalances[0]) / 1e9;
  tot += d;
  console.log(
    new Date(s.blockTime * 1000).toLocaleTimeString('zh-CN', { hour12: false }),
    (s.err ? '❌失败' : '✅成功').padEnd(6),
    d.toFixed(6).padStart(10),
    (t.meta.fee / 1e9).toFixed(6).padStart(10),
    s.err ? JSON.stringify(s.err).slice(0, 40) : ''
  );
}
console.log('\n合计变化:', tot.toFixed(6), 'SOL');
