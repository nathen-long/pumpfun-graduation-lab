// 全平卖出（只卖出，不买），带 HTTP 轮询确认
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = require('@solana/web3.js');
const BN = require('bn.js');
const { OnlinePumpSdk, PUMP_SDK } = require('@pump-fun/pump-sdk');

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const L = 1e9;
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
import { RPCS as RPCS_LOCAL } from './rpc.mjs';
const RPCS = RPCS_LOCAL;
const mintArg = process.argv[2];
if (!mintArg) { console.error('用法: node sell.mjs <mint>'); process.exit(1); }

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'keys', 'wallet.json'), 'utf8'))));
const user = kp.publicKey;
const mint = new PublicKey(mintArg);
let ep = 0, conn = new Connection(RPCS[0], 'confirmed'), online = new OnlinePumpSdk(conn);
const rotate = () => { ep = (ep + 1) % RPCS.length; conn = new Connection(RPCS[ep], 'confirmed'); online = new OnlinePumpSdk(conn); };
async function robust(fn, n = 4) {
  for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { if (i === n - 1) throw e; if (i >= 1) rotate(); await new Promise(r => setTimeout(r, 700)); } }
}
async function waitSig(sig, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = st.value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s;
      if (s && s.err) return s;
    } catch { rotate(); }
  }
  return null;
}

console.log(`\n钱包 ${user.toBase58()}`);
const bal0 = await robust(() => conn.getBalance(user));
const accts = await robust(() => conn.getParsedTokenAccountsByOwner(user, { mint }));
const raw = accts.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.amount), 0);
const ui = accts.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount), 0);
console.log(`余额 ${(bal0 / L).toFixed(6)} SOL | 持仓 ${ui.toLocaleString()} 枚`);
if (raw <= 0) { console.log('没有持仓，无需卖出'); process.exit(0); }

const mintInfo = await robust(() => conn.getAccountInfo(mint));
const tokenProgram = mintInfo.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_LEGACY;
const st = await robust(() => online.fetchBuyState(mint, user));
const global = await robust(() => online.fetchGlobal());
console.log(`曲线进度 ${(Number(st.bondingCurve.realQuoteReserves.toString()) / L / 85 * 100).toFixed(2)}% | 程序 ${tokenProgram.equals(TOKEN_2022) ? 'Token-2022' : 'SPL'}`);

const CU = Number(CFG.computeUnits || 200000), PRIO = Number((CFG.priorityFee || 0.0005) * L);
const ixs = await PUMP_SDK.sellInstructions({
  global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve,
  associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user,
  amount: new BN(String(raw)), solAmount: new BN(0), slippage: CFG.slippage || 5, tokenProgram,
});
const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
             ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(PRIO * 1e6 / CU) }), ...ixs];
const { blockhash } = await robust(() => conn.getLatestBlockhash('confirmed'));
const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
const tx = new VersionedTransaction(msg); tx.sign([kp]);

const sim = await robust(() => conn.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' }));
if (sim.value.err) {
  console.error('❌ 预演失败:', JSON.stringify(sim.value.err));
  (sim.value.logs || []).slice(-10).forEach(l => console.log('   ' + l));
  process.exit(1);
}
console.log(`预演通过 CU=${sim.value.unitsConsumed}`);
const t0 = Date.now();
const sig = await robust(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }));
console.log(`已发送 ${sig}\n等待确认…`);
const s = await waitSig(sig);
const ms = Date.now() - t0;
if (!s) { console.error('⚠️ 60 秒内未确认，请手工核对: ' + sig); process.exit(2); }
if (s.err) { console.error('❌ 链上失败:', JSON.stringify(s.err)); process.exit(1); }
const bal1 = await robust(() => conn.getBalance(user));
await new Promise(r => setTimeout(r, 1200));
const accts1 = await robust(() => conn.getParsedTokenAccountsByOwner(user, { mint }));
const left = accts1.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.amount), 0);
console.log(`\n✅ 卖出确认，${ms}ms，slot=${s.slot}`);
console.log(`   余额 ${(bal0 / L).toFixed(6)} → ${(bal1 / L).toFixed(6)} SOL`);
console.log(`   剩余持仓 ${left}（0 = 已全平）${accts1.value.length === 0 ? '  代币账户已关闭/回收租金 ✅' : ''}`);
fs.appendFileSync(path.join(ROOT, '..', 'logs', 'trades_live.jsonl'),
  JSON.stringify({ t: Date.now(), mint: mintArg, side: 'sell', sig, soldUi: ui, balBefore: bal0 / L, balAfter: bal1 / L, ms }) + '\n');
