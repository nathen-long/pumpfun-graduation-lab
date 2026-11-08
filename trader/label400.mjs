import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
const mints = fs.readFileSync('../feat400_mints.txt', 'utf8').split(/\r?\n/).filter(Boolean);
const RPC = JSON.parse(fs.readFileSync('./config.json', 'utf8')).rpc;
const c = new Connection(RPC, 'confirmed');
const o = new OnlinePumpSdk(c);
const W = new PublicKey('AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU');
const out0 = {};
let done = 0, g = 0, fail = 0;
for (const m of mints) {
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    try {
      const st = await o.fetchBuyState(new PublicKey(m), W);
      out0[m] = { complete: !!st.bondingCurve.complete, R: Number(st.bondingCurve.realQuoteReserves) / 1e9 };
      ok = true; done++; if (out0[m].complete) g++;
    } catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!ok) fail++;
  await new Promise(r => setTimeout(r, 45));
}
fs.writeFileSync('../labels400.json', JSON.stringify(out0));
console.log(`核验 ${done} 个，失败 ${fail}，其中已毕业 ${g} → P(毕业)=${(g / done * 100).toFixed(1)}%`);
