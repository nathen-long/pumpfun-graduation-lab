// 链上核验：抽样币的 complete 标志 → 干净的 P(毕业 | 到达 X% 进度)
import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');

const co = JSON.parse(fs.readFileSync(process.argv[2] || '../cohort.json', 'utf8'));
const PER = Number(process.argv[3] || 60);
const W = new PublicKey('AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU');
import { RPCS as RPC_ALL } from './rpc.mjs';
const RPC = RPC_ALL;
let ep = 0;
let conn = new Connection(RPC[0], 'confirmed');
let online = new OnlinePumpSdk(conn);

console.log('阈值   有效样本  毕业数  P(毕业)    打平线    差额');
console.log('-'.repeat(64));
for (const th of ['30', '40', '50', '60', '70']) {
  const ms = (co[th] || []).slice(0, PER);
  let g = 0, n = 0;
  for (const m of ms) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const st = await online.fetchBuyState(new PublicKey(m), W);
        n++;
        if (st.bondingCurve.complete === true) g++;
        break;
      } catch (e) {
        if (attempt === 0) { ep = (ep + 1) % RPC.length; conn = new Connection(RPC[ep], 'confirmed'); online = new OnlinePumpSdk(conn); await new Promise(r => setTimeout(r, 200)); }
      }
    }
    await new Promise(r => setTimeout(r, 60));
  }
  const R = 85 * Number(th) / 100;
  const be = Math.pow((30 + R) / 115, 2);
  const p = n ? g / n : 0;
  console.log(
    String(th).padStart(4) + '%  ' + String(n).padStart(8) + '  ' + String(g).padStart(5) +
    '  ' + (p * 100).toFixed(1).padStart(7) + '%  ' + (be * 100).toFixed(1).padStart(6) + '%  ' +
    ((p - be) * 100).toFixed(1).padStart(6) + 'pp  ' + (p > be ? '✅ 正期望' : '❌ 负期望'));
}
