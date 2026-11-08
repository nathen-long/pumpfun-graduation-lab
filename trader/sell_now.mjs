// 应急清仓：优先费=0，逐个卖出所有持仓，然后关闭代币账户回收租金
// 用法: node sell_now.mjs [--confirm]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const BN = require('bn.js');
const { OnlinePumpSdk, PUMP_SDK } = require('@pump-fun/pump-sdk');
const { createCloseAccountInstruction } = require('@solana/spl-token');

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const CONFIRM = process.argv.includes('--confirm');
const PRIO = Number(process.env.PRIO_SOL || 0);          // 默认 0：只付基础费 0.000005
const CU = 200000;
import { RPCS as RPCS_LOCAL } from './rpc.mjs';
const RPCS = RPCS_LOCAL;
let ep = 0, conn = new Connection(RPCS[0], 'confirmed'), online = new OnlinePumpSdk(conn);
const rotate = () => { ep = (ep + 1) % RPCS.length; conn = new Connection(RPCS[ep], 'confirmed'); online = new OnlinePumpSdk(conn); console.log('  ↻ RPC →', RPCS[ep]); };
async function robust(fn, n = 5) { for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { if (i === n - 1) throw e; if (i >= 1) rotate(); await new Promise(r => setTimeout(r, 800)); } } }

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'keys', 'wallet.json'), 'utf8'))));
const W = kp.publicKey;
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TLEG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function sendTx(ixs, label) {
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU })];
  if (PRIO > 0) all.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(PRIO * 1e6 / CU) }));
  all.push(...ixs);
  const { blockhash } = await robust(() => conn.getLatestBlockhash('confirmed'));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: W, recentBlockhash: blockhash, instructions: all }).compileToV0Message());
  tx.sign([kp]);
  const sim = await robust(() => conn.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' }));
  if (sim.value.err) { console.log(`   ⚠️ ${label} 预演失败 ${JSON.stringify(sim.value.err)}`); (sim.value.logs || []).slice(-5).forEach(l => console.log('     ' + l)); return null; }
  const sig = await robust(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }));
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      if (s.err) { console.log(`   ❌ ${label} 链上失败`, JSON.stringify(s.err)); return null; }
      return sig;
    }
  }
  console.log(`   ⚠️ ${label} 确认超时 ${sig}`); return sig;
}

(async () => {
  console.log(`\n钱包 ${W.toBase58()}`);
  let bal = await robust(() => conn.getBalance(W));
  console.log(`余额 ${(bal / 1e9).toFixed(6)} SOL   优先费 ${PRIO} SOL`);
  const held = [];
  for (const p of [TLEG, T22]) {
    const r = await robust(() => conn.getParsedTokenAccountsByOwner(W, { programId: p }));
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      if (Number(info.tokenAmount.amount) > 0) held.push({ mint: info.mint, raw: Number(info.tokenAmount.amount), ui: Number(info.tokenAmount.uiAmount), ata: a.pubkey, prog: p });
    }
  }
  if (!held.length) { console.log('没有持仓'); return; }
  console.log(`持仓 ${held.length} 个：` + held.map(h => h.mint.slice(0, 6) + ':' + h.ui.toLocaleString()).join(', '));
  if (!CONFIRM) { console.log('\n加 --confirm 才会真的卖'); return; }

  for (const h of held) {
    console.log(`\n▶ 卖出 ${h.mint.slice(0, 8)} (${h.ui.toLocaleString()} 枚)`);
    try {
      const mintPk = new PublicKey(h.mint);
      const mi = await robust(() => conn.getAccountInfo(mintPk));
      const tokenProgram = mi.owner.equals(T22) ? T22 : TLEG;
      const st = await robust(() => online.fetchBuyState(mintPk, W));
      if (st.bondingCurve.complete) { console.log('   已毕业 → 需要用 Jupiter 卖（先换这个脚本）'); continue; }
      const global = await robust(() => online.fetchGlobal());
      const ixs = await PUMP_SDK.sellInstructions({
        global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve,
        associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mintPk, user: W,
        amount: new BN(String(h.raw)), solAmount: new BN(0), slippage: 20, tokenProgram,
      });
      const sig = await sendTx(ixs, 'sell');
      if (sig) {
        console.log('   ✅ 卖出成功', sig);
        await new Promise(r => setTimeout(r, 1500));
        const b2 = await conn.getBalance(W);
        console.log(`   余额 ${(bal / 1e9).toFixed(6)} → ${(b2 / 1e9).toFixed(6)} SOL`);
        bal = b2;
        // 关闭代币账户，回收租金
        try {
          const ataIx = createCloseAccountInstruction(h.ata, W, W, [], tokenProgram);
          const t = new Transaction().add(ataIx);
          const csig = await sendAndConfirmTransaction(conn, t, [kp], { commitment: 'confirmed' });
          const b3 = await conn.getBalance(W);
          console.log(`   🧹 已关闭代币账户，回收租金 → 余额 ${(b3 / 1e9).toFixed(6)} SOL  (${csig.slice(0, 10)}…)`);
          bal = b3;
        } catch (e) { console.log('   ⚠️ 关闭账户失败:', String(e.message).slice(0, 80)); }
      }
    } catch (e) { console.log('   ❌ 失败:', String(e.message).slice(0, 120)); }
  }
  const fin = await conn.getBalance(W);
  console.log(`\n=== 最终余额 ${(fin / 1e9).toFixed(6)} SOL ===`);
})();
