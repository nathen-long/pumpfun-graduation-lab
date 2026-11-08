import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
const mints = fs.readFileSync('../reach50_mints.txt', 'utf8').split(/\r?\n/).filter(Boolean);
const meta = JSON.parse(fs.readFileSync('../reach50.json', 'utf8'));
const RPC = JSON.parse(fs.readFileSync('./config.json', 'utf8')).rpc;
const c = new Connection(RPC, 'confirmed');
const o = new OnlinePumpSdk(c);
const W = new PublicKey('AXnPU2KjJDxJVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU'.replace('JDxJXVB3', 'JDxJVB3z').padEnd(44,'U'));
let g = 0, n = 0;
for (const m of mints.slice(0, 120)) {
  try {
    const st = await o.fetchBuyState(new PublicKey(m), W);
    n++;
    if (st.bondingCurve.complete) g++;
  } catch (e) {}
  await new Promise(r => setTimeout(r, 70));
}
console.log(`样本 ${n} 个曾达到 50% 进度的币`);
console.log(`已毕业 ${g} 个 → P(毕业) = ${(g / n * 100).toFixed(1)}%`);
