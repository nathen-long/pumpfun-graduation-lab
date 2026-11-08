// hold-to-graduation 策略引擎 v1.0
// 入场：进度首次跨过 ENTRY_PCT（默认 55%）+ 币龄≥60s + Token-2022 扩展干净
// 出场：唯一条件是「毕业」(链上 complete=true) → 卖出；或持仓 >MAX_HOLD_H 小时 → 市价清掉
//       不设止损、不设止盈（这是数据支持的做法）
// 用法:
//   node graduation.mjs --once 900          纸面跑 900 秒
//   node graduation.mjs --live --confirm    真钱
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = require('@solana/web3.js');
const BN = require('bn.js');
import { WSS_POOL as WSS_POOL_LOCAL, RPCS as RPCS_LOCAL } from './rpc.mjs';
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const TAG = process.env.RUN_TAG || 'main';   // 并行对照组标识
const LIVE = process.argv.includes('--live') && process.argv.includes('--confirm');
const oi = process.argv.indexOf('--once'); const ONCE = oi > 0 ? Number(process.argv[oi + 1] || 600) : 0;

const S = {
  entryPct: Number(process.env.ENTRY_PCT || 55),     // 进度跨过此值买入
  rule: process.env.RULE || 'confirm',                 // confirm=守住确认制 | fast=秒拉制
  fastRiseSec: Number(process.env.FAST_RISE_SEC || 10),// 秒拉：首笔成交到跨线秒数上限
  confirmSec: Number(process.env.CONFIRM_SEC || 60),   // 跨过入场线后先观察多少秒（实测：守住≥50%的毕业率 76%）
  fakeDrop: Number(process.env.FAKE_DROP || 20),       // 确认期内跌到此幅度以下 → 判定假突破，永久放弃
  maxAbove: Number(process.env.MAX_ABOVE || 20),       // 高于入场线多少就不追
  minAgeSec: Number(process.env.MIN_AGE_SEC || 10),   // 实测：币到 50% 大多在出生 60s 内，门槛过高会几乎永不触发
  maxAgeSec: 3600,
  buySol: Number(process.env.SIZE_SOL || CFG.gradSize || 0.02),
  maxPos: Number(process.env.MAX_POS || CFG.maxPos || 5),
  maxExposure: Number(process.env.MAX_EXPOSURE || CFG.maxExposure || 0.25),
  maxHoldH: Number(process.env.MAX_HOLD_H || CFG.maxHoldH || 24),
  paperStart: Number(CFG.paperStartSol || 0.5),
  prioFee: Number(CFG.priorityFee || 0.0005),
  baseFee: 0.000005,
  ataRent: 0.00151384,
  slippage: Number(process.env.SLIPPAGE || CFG.gradSlippage || 15),
  feeReserve: Number(process.env.FEE_RESERVE || 0.012),   // 每开一仓额外要求的手续费+租金储备
};

const X0 = 30, K = 30 * 1.073e9, RG = 85, r = 1 - 0.0125;
const progOf = (R) => Math.max(0, Math.min(300, R / RG * 100));
const buyTokens = (R, d) => K / (X0 + R) - K / (X0 + R + d * r);
const sellSol = (R, h) => { if (h <= 0 || R <= 0) return 0; const v = K / (X0 + R); return Math.max(0, Math.min(((X0 + R) - K / (v + h)) * r, R)); };

// ---- 行情 ----
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSS = WSS_POOL_LOCAL;
const DISC = { trade: Buffer.from('bddb7fd34ee661ee', 'hex'), create: Buffer.from('1b72a94ddeeb6376', 'hex') };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (b) => { let z = 0; while (z < b.length && b[z] === 0) z++; const d = []; for (let i = z; i < b.length; i++) { let c = b[i]; for (let j = 0; j < d.length; j++) { c += d[j] * 256; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let s = '1'.repeat(z); for (let k = d.length - 1; k >= 0; k--) s += B58[d[k]]; return s; };
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
const i64 = (b, o) => Number(b.readBigInt64LE(o));
function parse(b) {
  try {
    if (b.length >= 129 && b.subarray(0, 8).equals(DISC.trade))
      return { e: 't', mint: b58(b.subarray(8, 40)), sol: u64(b, 40) / 1e9, buy: b[56] === 1, user: b58(b.subarray(57, 89)), ts: i64(b, 89) * 1000, rsol: u64(b, 113) / 1e9 };
    if (b.length > 100 && b.subarray(0, 8).equals(DISC.create)) {
      let o = 8; const rd = () => { const n = b.readUInt32LE(o); const s = b.slice(o + 4, o + 4 + n).toString('utf8'); o += 4 + n; return s; };
      const name = rd(), sym = rd(), uri = rd();
      return { e: 'c', mint: b58(b.subarray(o, o + 32)), creator: b58(b.subarray(o + 96, o + 128)), sym, ts: i64(b, o + 128) * 1000 };
    }
  } catch {}
  return null;
}
const books = new Map();
let feed = { ws: null, ep: 0, last: Date.now(), n: 0 };
let feedGen = 0;   // 连接代次：旧 socket 的迟到回调全部丢弃
function forceReconnect(why) {
  feedGen++;
  const old = feed.ws;
  feed.ws = null;
  if (old) { try { old.onopen = old.onmessage = old.onerror = old.onclose = null; old.close(); } catch {} }
  feed.ep++;
  log(`↻ 行情重连（${why}）→ ${WSS[feed.ep % WSS.length]}`);
  connect();
}
function connect() {
  const my = ++feedGen;
  const url = WSS[feed.ep % WSS.length];
  let ws;
  try { ws = new WebSocket(url); } catch { setTimeout(() => { if (my === feedGen) connect(); }, 2000); return; }
  feed.ws = ws;
  ws.onopen = () => {
    if (my !== feedGen) return;
    log(`行情连接 ${url}`);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }));
  };
  ws.onmessage = (m) => {
    if (my !== feedGen) return;
    feed.last = Date.now();
    let d; try { d = JSON.parse(m.data); } catch { return; }
    const v = d?.params?.result?.value; if (!v || !v.logs || v.err) return;
    feed.n++;
    for (const line of v.logs) {
      if (!line.startsWith('Program data: ')) continue;
      const ev = parse(Buffer.from(line.slice(14), 'base64'));
      if (!ev) continue;
      if (ev.e === 'c') { books.set(ev.mint, { ts: ev.ts || Date.now(), sym: ev.sym, rsol: 0, prev: 0, peak: 0, migrated: false, lastT: Date.now() }); continue; }
      if (!(ev.sol > 0)) continue;
      let b = books.get(ev.mint);
      if (!b) { b = { ts: ev.ts || Date.now(), sym: null, rsol: 0, prev: 0, peak: 0, migrated: false, lastT: Date.now() }; books.set(ev.mint, b); }
      b.prev = b.rsol; b.rsol = ev.rsol; b.lastT = Date.now();
      if (ev.rsol > b.peak) b.peak = ev.rsol;
      // 记录首次跨过入场线（用于"守住确认"入场：跨过后等 N 秒仍守住才买）
      const pp = progOf(ev.rsol);
      if (pp >= S.entryPct && !b.tCross) { b.tCross = Date.now(); b.minSince = pp; }
      else if (b.tCross && pp < (b.minSince === undefined ? 999 : b.minSince)) b.minSince = pp;
      // 迁移检测：储备从高位直接归零
      if (b.prev > 40 && ev.rsol < 1) b.migrated = true;
      if (!b.firstT) b.firstT = b.ts || Date.now();
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (my !== feedGen) return;
    feed.ep++;
    setTimeout(() => { if (my === feedGen) connect(); }, 1200);
  };
}
// 看门狗：12 秒无消息 = 半开连接（close() 不会触发 onclose），必须强制换新连接
setInterval(() => {
  if (Date.now() - feed.last > 12000) forceReconnect(`静默 ${((Date.now() - feed.last) / 1000).toFixed(0)}s`);
}, 2000);

// ---- 链上 ----
const RPCS = RPCS_LOCAL;
let ep = 0, conn = new Connection(RPCS[0], 'confirmed'), online = new OnlinePumpSdk(conn);
const rotate = () => { ep = (ep + 1) % RPCS.length; conn = new Connection(RPCS[ep], 'confirmed'); online = new OnlinePumpSdk(conn); console.log(`  ↻ RPC → ${RPCS[ep]}`); };
async function robust(fn, n = 4) { for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { if (i === n - 1) throw e; if (i >= 1) rotate(); await new Promise(x => setTimeout(x, 600)); } } }
const kp = LIVE ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'keys', 'wallet.json'), 'utf8')))) : null;
const WALLET = new PublicKey(kp ? kp.publicKey.toBase58() : CFG.wallet);

const log = (m) => { const s = `[${TAG}][${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`; console.log(s); fs.appendFileSync(path.join(ROOT, '..', 'logs', `graduation_${TAG}.log`), s + String.fromCharCode(10)); };
const rec = (o) => fs.appendFileSync(path.join(ROOT, '..', 'logs', `graduation_trades_${TAG}.jsonl`), JSON.stringify(o) + String.fromCharCode(10));

const state = { bal: S.paperStart, pos: new Map(), done: [], wins: 0, losses: 0 };

// ---- 纸面账本持久化（常驻运行必须，重启不能归零）----
const LEDGER = path.join(ROOT, '..', 'data', 'grad', `ledger_${TAG}.json`);
function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    if (raw.v !== 1) return;
    state.bal = Number(raw.bal) || S.paperStart;
    state.wins = Number(raw.wins) || 0;
    state.losses = Number(raw.losses) || 0;
    state.done = Array.isArray(raw.done) ? raw.done : [];
    for (const p of (raw.pos || [])) { state.pos.set(p.mint, p); seen.add(p.mint); }
    log(`📂 恢复纸面账本：余额 ${state.bal.toFixed(4)} SOL，持仓 ${state.pos.size} 个，已平 ${state.done.length} 笔`);
  } catch {}
}
function saveLedger() {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({
      v: 1, t: Date.now(), day: new Date().toLocaleDateString('sv-SE'),
      bal: state.bal, wins: state.wins, losses: state.losses,
      done: state.done.slice(-500), pos: [...state.pos.values()],
    }, null, 1));
  } catch (e) { }
}
const seen = new Set();
const pending = new Set();   // v1.1：异步买入期间的单币锁，修"同一币被买两次"

async function buy(mint, b) {
  const size = S.buySol;
  // 注意：不要在这里判断 pending —— 扫描是先 pending.add() 再调本函数，判断会永远返回"进行中"
  if (state.pos.size >= S.maxPos) return '满仓';
  if (state.pos.size * size >= S.maxExposure) return '敞口满';
  // 实盘必须按真实 SOL 余额判断，并给手续费/租金留足储备（修复：原来用纸面 0.5 判断，导致把钱花光卖不出去）
  if (LIVE) {
    let real = 0;
    try { real = (await conn.getBalance(WALLET)) / 1e9; } catch { return '余额查询失败'; }
    state.bal = real;
    if (real < size + S.feeReserve) { log(`💰 余额 ${real.toFixed(4)} SOL 不足以开新仓（需 ${(size + S.feeReserve).toFixed(3)}+储备）`); return '余额不足'; }
  } else if (state.bal < size + 0.003) return '余额不足';
  const entryProg = progOf(b.rsol);
  if (!LIVE) {
    const tok = buyTokens(b.rsol, size);
    const cost = size + S.prioFee + S.baseFee + S.ataRent;
    state.bal -= cost;
    state.pos.set(mint, { mint, tok, cost, entryR: b.rsol, entryProg, opened: Date.now(), sym: b.sym, peak: entryProg, mode: 'paper' });
    rec({ t: Date.now(), mint, sym: b.sym, side: 'buy', mode: 'paper', size, entryProg });
    saveLedger();
    log(`📄 买入 ${String(b.sym || mint.slice(0, 6)).padEnd(9)} 进度 ${entryProg.toFixed(1)}%  ${size} SOL 得 ${(tok / 1e4).toFixed(1)}万枚  余额 ${state.bal.toFixed(3)}`);
    return null;
  }
  try {
    const mintPk = new PublicKey(mint);
    const mi = await robust(() => conn.getAccountInfo(mintPk));
    const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const tokenProgram = mi.owner.equals(T22) ? T22 : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    if (mi.owner.equals(T22)) {   // 扩展安全检查
      const EXTF = { 1: 'TransferFee', 6: 'DefaultState', 9: 'NonTransferable', 12: 'PermDelegate', 14: 'TransferHook', 25: 'Pausable' };
      let o = 83, bad = mi.data[0] === 1 || mi.data[46] === 1;
      while (o + 4 <= mi.data.length) { const t = mi.data.readUInt16LE(o), l = mi.data.readUInt16LE(o + 2); if (!t && !l) break; if (EXTF[t]) bad = true; o += 4 + l; if (l % 2) o++; }
      if (bad) { log(`⛔ ${mint.slice(0, 8)} 扩展不安全，跳过`); return '不安全'; }
    }
    const st = await robust(() => online.fetchBuyState(mintPk, WALLET));
    if (st.bondingCurve.complete) return '已毕业';
    const global = await robust(() => online.fetchGlobal());
    const feeConfig = await robust(() => online.fetchFeeConfig());
    const budget = new BN(Math.round(size * 1e9));
    const tok = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: budget, quoteMint: st.quoteMint, quoteControl: null, creatorFeeBps: st.bondingCurve.creatorFeeBps, pumpQuote: null, quoteTransferFee: st.quoteTransferFee });
    const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mintPk, user: WALLET, amount: tok, solAmount: budget, slippage: S.slippage, tokenProgram });
    const sig = await sendTx(ixs);
    let raw = 0;
    for (let i = 0; i < 20 && !raw; i++) { await new Promise(x => setTimeout(x, 1000)); const a = await conn.getParsedTokenAccountsByOwner(WALLET, { mint: mintPk }); raw = a.value.reduce((s, x) => s + Number(x.account.data.parsed.info.tokenAmount.amount), 0); }
    state.pos.set(mint, { mint, tok: raw / 1e6, tokRaw: raw, cost: size + S.prioFee + S.baseFee + S.ataRent, entryR: b.rsol, entryProg, opened: Date.now(), sym: b.sym, peak: entryProg, mode: 'live' });
    rec({ t: Date.now(), mint, sym: b.sym, side: 'buy', mode: 'live', sig, size, entryProg, tokens: raw });
    log(`🟢 实盘买入 ${mint.slice(0, 8)} ${entryProg.toFixed(1)}% sig=${sig}`);
    return null;
  } catch (e) { log(`❌ 买入失败 ${mint.slice(0, 8)}: ${String(e.message).slice(0, 110)}`); return '失败'; }
}

async function sendTx(ixs) {
  const CU = 200000, PRIO = Math.round(S.prioFee * 1e9);
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(PRIO * 1e6 / CU) }), ...ixs];
  const { blockhash } = await robust(() => conn.getLatestBlockhash('confirmed'));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: blockhash, instructions: all }).compileToV0Message());
  tx.sign([kp]);
  const sig = await robust(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }));
  for (let i = 0; i < 45; i++) {
    await new Promise(x => setTimeout(x, 1000));
    const s = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { if (s.err) throw new Error('链上失败 ' + JSON.stringify(s.err)); return sig; }
  }
  throw new Error('确认超时 ' + sig);
}

// Jupiter 卖出（毕业后的币走 PumpSwap 池，聚合器自动路由）
async function jupSell(mint, rawAmount) {
  const q = await robust(async () => {
    const u = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${rawAmount}&slippageBps=${S.slippage * 100}`;
    const r = await fetch(u); if (!r.ok) throw new Error('quote ' + r.status); return r.json();
  });
  const sw = await robust(async () => {
    const r = await fetch('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userPublicKey: WALLET.toBase58(), quoteResponse: q, wrapAndUnwrapSol: true }) });
    if (!r.ok) throw new Error('swap ' + r.status); return r.json();
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, 'base64'));
  tx.sign([kp]);
  const sig = await robust(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }));
  for (let i = 0; i < 45; i++) {
    await new Promise(x => setTimeout(x, 1000));
    const s = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) { if (s.err) throw new Error('链上失败'); return { sig, out: Number(q.outAmount) / 1e9 }; }
  }
  throw new Error('确认超时');
}

async function exitPos(mint, why, graduated) {
  const p = state.pos.get(mint); if (!p) return;
  const b = books.get(mint) || {};
  if (!LIVE) {
    const R = graduated ? RG * 0.99 : (b.rsol || 0);
    const got = graduated ? sellSol(RG * 0.99, p.tok) : sellSol(R, p.tok);
    const fee = S.prioFee + S.baseFee;
    const net = got - fee + S.ataRent;
    const pnl = net - p.cost;
    state.bal += net;
    state.pos.delete(mint);
    if (pnl >= 0) state.wins++; else state.losses++;
    state.done.push(pnl);
    rec({ t: Date.now(), mint, sym: p.sym, side: 'sell', mode: 'paper', why, pnl, ret: pnl / p.cost, holdMin: (Date.now() - p.opened) / 60000 });
    saveLedger();
    log(`${pnl >= 0 ? '🎯' : '💀'} 卖出 ${String(p.sym || mint.slice(0, 6)).padEnd(9)} ${why} | ${(pnl / p.cost * 100).toFixed(1)}% (${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL) 持仓 ${((Date.now() - p.opened) / 60000).toFixed(0)}分  余额 ${state.bal.toFixed(3)}`);
    return;
  }
  try {
    // 毕业后：Jupiter 路由到 PumpSwap；未毕业：直接走曲线卖
    let res;
    if (graduated) {
      res = await jupSell(mint, Math.floor(p.tokRaw || p.tok * 1e6));
      log(`🔴 Jupiter 卖出 ${mint.slice(0, 8)} 得 ${res.out.toFixed(4)} SOL sig=${res.sig}`);
    } else {
      const mintPk = new PublicKey(mint);
      const mi = await robust(() => conn.getAccountInfo(mintPk));
      const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      const tokenProgram = mi.owner.equals(T22) ? T22 : new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const st = await robust(() => online.fetchBuyState(mintPk, WALLET));
      const global = await robust(() => online.fetchGlobal());
      const ixs = await PUMP_SDK.sellInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mintPk, user: WALLET, amount: new BN(String(Math.floor(p.tokRaw || p.tok * 1e6))), solAmount: new BN(0), slippage: S.slippage, tokenProgram });
      const sig = await sendTx(ixs);
      log(`🔴 曲线卖出 ${mint.slice(0, 8)} sig=${sig}`);
    }
    state.pos.delete(mint);
    rec({ t: Date.now(), mint, side: 'sell', mode: 'live', why });
  } catch (e) {
    p.sellFail = (p.sellFail || 0) + 1;
    log(`❌ 卖出失败 ${mint.slice(0, 8)} (${p.sellFail}/5): ${String(e.message).slice(0, 110)}${p.sellFail >= 5 ? ' → 需人工介入' : '（下轮重试）'}`);
  }
}

// ---- 入场扫描 ----
setInterval(() => {
  const now = Date.now();
  for (const [mint, b] of books) {
    if (seen.has(mint) || state.pos.has(mint)) continue;
    const age = (now - b.ts) / 1000;
    if (age < S.minAgeSec) continue;
    if (age > S.maxAgeSec) { seen.add(mint); continue; }
    if (b.migrated) { seen.add(mint); continue; }
    if (!b.rsol) continue;
    const p = progOf(b.rsol);
    if (S.rule === 'fast') {
      // 秒拉制：跨过入场线的当下，要求「首笔成交→跨线」足够快
      if (p < S.entryPct) continue;
      if (p > S.entryPct + S.maxAbove) { seen.add(mint); continue; }
      const rise = ((b.tCross || now) - (b.firstT || b.ts)) / 1000;
      if (rise > S.fastRiseSec) { seen.add(mint); continue; }   // 磨上去的不买
      seen.add(mint); pending.add(mint);
      buy(mint, b).then((e) => {
        pending.delete(mint);
        if (e && !['满仓','敞口满','余额不足','进行中','余额查询失败'].includes(e)) seen.add(mint);
        else if (!e) { } else seen.delete(mint);
      });
      continue;
    }
    // 确认制：跨过入场线后必须先观察 confirmSec 秒
    if (!b.tCross) { if (p >= S.entryPct) b.tCross = Date.now(); continue; }
    const sinceCross = (now - b.tCross) / 1000;
    if (sinceCross < S.confirmSec) continue;
    // 假突破否决：确认期内曾经跌破 fakeDrop → 永久放弃（实测这批毕业率仅 4.4%）
    if (b.minSince !== undefined && b.minSince < S.entryPct - S.fakeDrop) { seen.add(mint); continue; }
    // 确认期内容量必须全程守住入场线（离线验证：守住≥50% 毕业率 76.2%，跌破过的仅 21~33%）
    if (b.minSince === undefined || b.minSince < S.entryPct) continue;
    if (p < S.entryPct) continue;
    if (p > S.entryPct + S.maxAbove) { seen.add(mint); continue; }   // 已经冲太高不追
    if (p > S.entryPct + S.maxAbove) { seen.add(mint); continue; }   // 已经冲太高不追
    if (process.env.ENGINE_DEBUG) log(`🎯 候选 ${b.sym || mint.slice(0, 6)} 进度 ${progOf(b.rsol).toFixed(1)}% 币龄 ${age.toFixed(0)}s`);
    seen.add(mint);
    pending.add(mint);
    buy(mint, b).then((e) => {
      pending.delete(mint);
      if (e && !['满仓', '敞口满', '余额不足', '进行中', '余额查询失败'].includes(e)) { seen.add(mint); }
      else if (!e) { /* 成功，仓位已在 pos 里 */ }
      else { seen.delete(mint); }   // 只是暂时没钱/满仓 → 以后还能再试
    });
  }
}, 1000);

// ---- 调试统计 ----
if (process.env.ENGINE_DEBUG) setInterval(() => {
  const now = Date.now(); let scanned = 0, ageOk = 0, near = 0, band = 0;
  for (const [m, b] of books) {
    if (seen.has(m) || state.pos.has(m)) continue;
    scanned++;
    const age = (now - b.ts) / 1000;
    if (age < S.minAgeSec) continue;
    ageOk++;
    if (!b.rsol) continue;
    const p = progOf(b.rsol);
    if (p >= S.entryPct - 5) near++;
    if (p >= S.entryPct && p <= S.entryPct + 12) band++;
  }
  log(`🔍 扫描 ${scanned} 未处理 | 过币龄 ${ageOk} | 距门槛5pp内 ${near} | 区间内 ${band} | minAge=${S.minAgeSec} entry=${S.entryPct}`);
}, 5000);

// ---- 毕业检测（链上确认，每 45 秒轮询持仓） ----
setInterval(async () => {
  for (const [mint, p] of state.pos) {
    // a) 行情侧：储备从高位归零 = 迁移
    const b = books.get(mint);
    let grad = !!(b && b.migrated);
    // b) 链上兜底：直接问 complete
    if (!grad) {
      try {
        const st = await online.fetchBuyState(new PublicKey(mint), WALLET);
        grad = st.bondingCurve.complete === true;
      } catch {}
    }
    if (grad) { exitPos(mint, '毕业', true); continue; }
    if ((Date.now() - p.opened) / 3600000 > S.maxHoldH) { exitPos(mint, '超时清仓', false); continue; }
  }
}, 45000);

// 实盘：定期刷新真实钱包余额
if (LIVE) setInterval(async () => { try { globalThis.__realBal = (await conn.getBalance(WALLET)) / 1e9; } catch {} }, 30000);

// ---- 状态行 ----
let lastLog = 0;
setInterval(() => {
  if (Date.now() - lastLog < 20000) return;
  lastLog = Date.now();
  const open = [...state.pos.entries()].map(([m, p]) => {
    const b = books.get(m);
    const cur = b ? progOf(b.rsol) : 0;
    const val = b ? sellSol(b.rsol, p.tok) : 0;
    const pnl = p.cost > 0 ? (val / p.cost - 1) * 100 : 0;
    return `${String(p.sym || m.slice(0, 4)).slice(0, 8)}:${p.entryProg.toFixed(0)}→${cur.toFixed(0)}%(${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}%)`;
  }).join(' ');
  if (LIVE && globalThis.__realBal !== undefined) state.bal = globalThis.__realBal;
  log(`📊 行情${feed.n} 追踪${books.size} 持仓${state.pos.size}/${S.maxPos} 已平${state.done.length} 胜${state.wins}负${state.losses} 余额${state.bal.toFixed(3)} ${open}`);
}, 5000);

if (!LIVE) loadLedger();
setInterval(() => { if (!LIVE) saveLedger(); }, 60000);
log(`[${TAG}] 规则=${S.rule}${S.rule === 'fast' ? `(秒拉≤${S.fastRiseSec}s)` : `(确认${S.confirmSec}s)`} | 模式 ${LIVE ? '🔴 实盘' : '📄 纸面'} | 门槛 进度≥${S.entryPct}% | 单笔 ${S.buySol} SOL | 最多 ${S.maxPos} 仓 | 不设止损止盈 | 最长 ${S.maxHoldH} 小时`);
connect();
if (ONCE) setTimeout(() => {
  const tot = state.done.reduce((a, b) => a + b, 0);
  log(`\n===== 纸面结算 =====\n已平 ${state.done.length} 笔 | 胜 ${state.wins} 负 ${state.losses} | 总盈亏 ${tot >= 0 ? '+' : ''}${tot.toFixed(4)} SOL | 余额 ${state.bal.toFixed(3)} SOL（起始 ${S.paperStart}）`);
  process.exit(0);
}, ONCE * 1000);
