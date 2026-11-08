// 真钱买入 + 卖出验证（默认需要 --confirm 才会真的发交易）
// 用法:
//   node buy_live.mjs <mint> <SOL数量> --confirm     真实下单
//   node buy_live.mjs <mint> <SOL数量>               只模拟（等同 dryrun）
// 前置: keys/wallet.json 已由 导入私钥.bat 生成
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = require('@solana/web3.js');
const BN = require('bn.js');
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const L = 1e9;
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } })();
const RPC = process.env.SOLANA_RPC || CFG.rpc || 'https://api.mainnet-beta.solana.com';
const CONFIRM = process.argv.includes('--confirm');
const mintArg = process.argv[2];
const sizeSol = Number(process.argv[3] || 0.01);
if (!mintArg) { console.error('用法: node buy_live.mjs <mint> <SOL> [--confirm]'); process.exit(1); }

// ---- 安全闸门 ----
const MAX_ORDER = Number(CFG.maxOrderSol || 0.02);
if (sizeSol > MAX_ORDER) { console.error(`❌ 单笔 ${sizeSol} SOL 超过上限 ${MAX_ORDER}（config.json 的 maxOrderSol）`); process.exit(1); }
const kpPath = path.join(ROOT, '..', 'keys', 'wallet.json');
let kp = null;
if (fs.existsSync(kpPath)) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8'))));
if (CONFIRM && !kp) { console.error('❌ 没有 keys/wallet.json —— 先双击 导入私钥.bat'); process.exit(1); }
const user = kp ? kp.publicKey : new PublicKey(CFG.wallet);

// 多端点轮换 + 重试：公共 RPC 会限流，实盘必须能自动换节点
import { RPCS as RPCS_LOCAL } from './rpc.mjs';
const RPCS = RPCS_LOCAL;
let epIdx = 0;
let conn = new Connection(RPCS[0], 'confirmed');
let online = new OnlinePumpSdk(conn);
function rotate() {
  epIdx = (epIdx + 1) % RPCS.length;
  conn = new Connection(RPCS[epIdx], 'confirmed');
  online = new OnlinePumpSdk(conn);
  console.error(`   ↻ 切换 RPC → ${RPCS[epIdx]}`);
}
async function robust(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      if (i >= 1) rotate();
      await new Promise(r => setTimeout(r, 700 * (i + 1)));
    }
  }
}
const mint = new PublicKey(mintArg);

const bal = await robust(() => conn.getBalance(user));
console.log(`\n钱包 ${user.toBase58()}\n余额 ${(bal / L).toFixed(6)} SOL   模式 ${CONFIRM ? '🔴 真实下单' : '🧪 仅模拟'}`);

const mintInfo = await robust(() => conn.getAccountInfo(mint));
if (!mintInfo) { console.error('币不存在'); process.exit(1); }
const tokenProgram = mintInfo.owner.equals(TOKEN_2022) ? TOKEN_2022 : TOKEN_LEGACY;
// Token-2022 扩展安全检查：有 hook / 转账税 / 永久委托 就拒绝
if (mintInfo.owner.equals(TOKEN_2022)) {
  const EXT = { 1: 'TransferFeeConfig', 6: 'DefaultAccountState', 9: 'NonTransferable', 12: 'PermanentDelegate', 14: 'TransferHook', 25: 'Pausable' };
  const found = []; let o = 83;
  while (o + 4 <= mintInfo.data.length) {
    const t = mintInfo.data.readUInt16LE(o), len = mintInfo.data.readUInt16LE(o + 2);
    if (t === 0 && len === 0) break;
    if (EXT[t]) found.push(EXT[t]);
    o += 4 + len; if (len % 2) o++;
  }
  const mintAuth = mintInfo.data[0] === 1, freezeAuth = mintInfo.data[46] === 1;
  console.log(`代币程序 Token-2022 | 扩展: ${found.join(',') || '无'} | mintAuth=${mintAuth} freezeAuth=${freezeAuth}`);
  if (found.length || mintAuth || freezeAuth) { console.error(`❌ 安全闸门：该币带扩展或权限未撤销，拒绝买入`); process.exit(1); }
  console.log('   ✅ 扩展为空、权限已撤销');
} else console.log('代币程序 老 SPL');

const st = await robust(() => online.fetchBuyState(mint, user));
const bc = st.bondingCurve;
if (bc.complete) { console.error('该币已毕业，内盘不可买'); process.exit(1); }
const progress = Number(bc.realQuoteReserves.toString()) / L / 85 * 100;
const global = await robust(() => online.fetchGlobal());
const feeConfig = await robust(() => online.fetchFeeConfig());
const budget = new BN(Math.round(sizeSol * L));
const qargs = { global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, quoteMint: st.quoteMint,
  quoteControl: null, creatorFeeBps: bc.creatorFeeBps, pumpQuote: null, quoteTransferFee: st.quoteTransferFee };
const tokens = getBuyTokenAmountFromSolAmount({ ...qargs, amount: budget });
const back = getSellSolAmountFromTokenAmount({ ...qargs, amount: tokens });
console.log(`曲线进度 ${progress.toFixed(2)}% | 计划买入 ${sizeSol} SOL → ${(Number(tokens.toString()) / 1e6).toLocaleString()} 枚 | 立即卖回 ${(Number(back.toString()) / L).toFixed(6)} SOL`);

const CU = Number(CFG.computeUnits || 180000);
const PRIO = Number((CFG.priorityFee || 0.0005) * L);
const buildIxs = (kind, amount, solAmount) => PUMP_SDK[kind === 'buy' ? 'buyInstructions' : 'sellInstructions']({
  global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc,
  associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user,
  amount, solAmount, slippage: CFG.slippage || 5, tokenProgram,
});
async function send(ixs, label) {
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
               ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(PRIO * 1e6 / CU) }), ...ixs];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  // ① 先带签名预演：这一步能拿到真实日志（公共 RPC 的 sendRawTransaction preflight 经常返回空日志）
  const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });   // 不能与 replaceRecentBlockhash 同时用
  if (sim.value.err) {
    console.error(`   ⚠️ 预演失败: ${JSON.stringify(sim.value.err)}  CU=${sim.value.unitsConsumed}`);
    (sim.value.logs || []).slice(-12).forEach(l => console.log('      ' + l));
    throw new Error('preflight failed');
  }
  console.log(`   预演通过 CU=${sim.value.unitsConsumed}`);
  // ② 正式发送（关掉 preflight：状态在秒级变化，preflight 反而会误判）
  const t0 = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const ms = Date.now() - t0;
  let meta = null;
  for (let i = 0; i < 10 && !meta; i++) {
    meta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!meta) await new Promise(r => setTimeout(r, 800));
  }
  if (conf.value.err) {
    console.error('   链上执行失败:', JSON.stringify(conf.value.err));
    (meta?.meta?.logMessages || []).slice(-12).forEach(l => console.log('      ' + l));
  }
  return { sig, err: conf.value.err, fee: meta?.meta?.fee, logs: meta?.meta?.logMessages, ms };
}

if (!CONFIRM) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const ixs = await buildIxs('buy', tokens, budget);
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(PRIO * 1e6 / CU) }),
    ...ixs,
  ];
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  console.log(sim.value.err ? `🧪 模拟失败: ${JSON.stringify(sim.value.err)}` : `🧪 模拟成功 CU=${sim.value.unitsConsumed}`);
  console.log('加 --confirm 才会真实下单');
  process.exit(0);
}

// ① 真实买入
console.log('\n① 买入…');
const r1 = await send(await buildIxs('buy', tokens, budget), 'buy');
if (r1.err) { console.error('❌ 买入失败:', JSON.stringify(r1.err)); (r1.logs || []).slice(-6).forEach(l => console.log('  ' + l)); process.exit(1); }
console.log(`   ✅ ${r1.sig}  ${r1.ms}ms  手续费 ${r1.fee} lamports`);

// ② 核对实际持仓
// 轮询直到代币到账（最多 20 秒），避免节点延迟导致对账误判
let held = 0, heldUi = 0;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const accts = await conn.getParsedTokenAccountsByOwner(user, { mint });
  held = accts.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
  heldUi = accts.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount), 0);
  if (held > 0) break;
}
const balAfter = await conn.getBalance(user);
const spent = (bal - balAfter) / L;
console.log(`   实际花费 ${spent.toFixed(6)} SOL（含手续费与租金）  实际到账 ${heldUi.toLocaleString()} 枚`);
console.log(`   预期代币 ${(Number(tokens.toString()) / 1e6).toLocaleString()} 枚  偏差 ${((heldUi / (Number(tokens.toString()) / 1e6) - 1) * 100).toFixed(2)}%`);

// ③ 立刻卖出，测真实往返损耗
console.log('\n② 全部卖出…');
const st2 = await online.fetchBuyState(mint, user);
const bc2 = st2.bondingCurve;
const ixsSell = await PUMP_SDK.sellInstructions({ global, bondingCurveAccountInfo: st2.bondingCurveAccountInfo, bondingCurve: bc2,
  associatedUserAccountInfo: st2.associatedUserAccountInfo, mint, user, amount: new BN(String(held)),
  solAmount: new BN(0), slippage: CFG.slippage || 5, tokenProgram });
const r2 = await send(ixsSell, 'sell');
if (r2.err) { console.error('❌ 卖出失败:', JSON.stringify(r2.err)); (r2.logs || []).slice(-8).forEach(l => console.log('  ' + l)); process.exit(1); }
await new Promise(r => setTimeout(r, 1500));
const balEnd = await conn.getBalance(user);
console.log(`   ✅ ${r2.sig}  ${r2.ms}ms  手续费 ${r2.fee} lamports`);
console.log(`   回款后余额 ${(balEnd / L).toFixed(6)} SOL`);

// ④ 对账
const roundTrip = (1 - balEnd / bal) * 100;
console.log('\n=== 对账 ===');
console.log(`  初始 ${(bal / L).toFixed(6)} → 结束 ${(balEnd / L).toFixed(6)} SOL`);
console.log(`  实测往返损耗 ${roundTrip.toFixed(2)}%（含 ATA 租金 ${held > 0 && balEnd < bal ? '未确定是否回收' : ''}）`);
console.log(`  模型预测（ATA不回收）${(((1 - Number(back.toString()) / Number(budget.toString())) + (0.00102 / sizeSol)) * 100).toFixed(2)}%`);
const rec = { t: Date.now(), mint: mintArg, size: sizeSol, tokens: held, buySig: r1.sig, sellSig: r2.sig,
  balStart: bal / L, balEnd: balEnd / L, roundTripPct: +roundTrip.toFixed(3), fees: [r1.fee, r2.fee] };
fs.appendFileSync(path.join(ROOT, '..', 'logs', 'trades_live.jsonl'), JSON.stringify(rec) + '\n');
console.log(`  回执已写入 logs/trades_live.jsonl`);
