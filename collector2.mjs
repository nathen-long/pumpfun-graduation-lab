#!/usr/bin/env node
/* pump.fun tick 采集器 v1.1（多端点轮换 + 看门狗重连 + 同步日志）
 * 用法: node collector2.mjs [秒数] [日志文件]
 * 公共 RPC 的 logsSubscribe 会在收够一批消息后静默停止推送，
 * 所以这里每 12 秒无消息就主动断开换端点重连；实测可稳定长期跑。
 */
import fs from 'node:fs';
import path from 'node:path';

import { WSS_POOL as WS_POOL_CFG } from './trader/rpc.mjs';
const WS_POOL = WS_POOL_CFG;
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SECONDS = Number(process.argv[2] || 600);
const LOGFILE = path.join(import.meta.dirname, process.argv[3] || 'collect.log');
const OUT = path.join(import.meta.dirname, 'data');
fs.mkdirSync(OUT, { recursive: true });
const F = { coins: path.join(OUT, 'coins.jsonl'), trades: path.join(OUT, 'trades.jsonl'), snaps: path.join(OUT, 'snapshots.jsonl') };
// 单实例锁：防止多个采集器同时写同一批文件
const PIDF = path.join(OUT, '.collector.pid');
try {
  const old = parseInt(fs.readFileSync(PIDF, 'utf8').trim() || '0', 10);
  if (old > 0 && old !== process.pid) {
    try { process.kill(old, 0); console.error(`已有采集器在跑 PID=${old}，本实例退出`); process.exit(0); } catch {}
  }
} catch {}
fs.writeFileSync(PIDF, String(process.pid));
process.on('exit', () => { try { if (fs.readFileSync(PIDF, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PIDF); } catch {} });

const DISC = { trade: Buffer.from('bddb7fd34ee661ee', 'hex'), create: Buffer.from('1b72a94ddeeb6376', 'hex'), complete: Buffer.from('5f72619cd42e9808', 'hex') };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const logf = (s) => { const line = s + '\n'; try { fs.appendFileSync(LOGFILE, line); } catch {} };
function b58(buf) {
  let zeros = 0; while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const d = [];
  for (let i = zeros; i < buf.length; i++) { let c = buf[i]; for (let j = 0; j < d.length; j++) { c += d[j] * 256; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let s = '1'.repeat(zeros); for (let k = d.length - 1; k >= 0; k--) s += B58[d[k]]; return s;
}
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
const i64 = (b, o) => Number(b.readBigInt64LE(o));
function bs(b, o) { const n = b.readUInt32LE(o); return { s: b.slice(o + 4, o + 4 + n).toString('utf8'), next: o + 4 + n }; }

function parseData(b) {
  try {
    if (b.length >= 129 && b.subarray(0, 8).equals(DISC.trade)) {
      return { e: 'trade', mint: b58(b.subarray(8, 40)), sol: u64(b, 40) / 1e9, token: u64(b, 48), isBuy: b[56] === 1,
               user: b58(b.subarray(57, 89)), ts: i64(b, 89) * 1000, vsol: u64(b, 97) / 1e9, rsol: u64(b, 113) / 1e9 };
    }
    if (b.length > 100 && b.subarray(0, 8).equals(DISC.create)) {
      let o = 8;
      const n1 = bs(b, o); o = n1.next; const n2 = bs(b, o); o = n2.next; const n3 = bs(b, o); o = n3.next;
      return { e: 'create', name: n1.s, sym: n2.s, uri: n3.s, mint: b58(b.subarray(o, o + 32)), curve: b58(b.subarray(o + 32, o + 64)),
               user: b58(b.subarray(o + 64, o + 96)), creator: b58(b.subarray(o + 96, o + 128)), ts: i64(b, o + 128) * 1000 };
    }
    if (b.length > 8 && b.subarray(0, 8).equals(DISC.complete)) return { e: 'complete' };
  } catch {}
  return null;
}

const coins = new Map();
const buf = { coins: [], trades: [], snaps: [] };
const stat = { notes: 0, trades: 0, creates: 0, completes: 0, conns: 0, started: Date.now() };
const seenSig = new Set();
const flush = () => { for (const k in buf) { if (buf[k].length) { fs.appendFileSync(F[k], buf[k].join('\n') + '\n'); buf[k] = []; } } };

function onEvent(ev, slot, sig) {
  if (!ev) return;
  const now = Date.now();
  if (ev.e === 'create') {
    stat.creates++;
    const c = { mint: ev.mint, ts: ev.ts || now, creator: ev.creator, sym: ev.sym, name: ev.name, uri: ev.uri, curve: ev.curve, slot, sig, devBuy: 0, rsol: 0 };
    coins.set(ev.mint, c); buf.coins.push(JSON.stringify(c)); return;
  }
  if (ev.e === 'complete') { stat.completes++; return; }
  if (!(ev.sol > 0)) { stat.nonSol = (stat.nonSol || 0) + 1; return; }   // 非 SOL 计价（USDC/币币对），本策略不做
  stat.trades++;
  let c = coins.get(ev.mint);
  if (!c) { c = { mint: ev.mint, ts: ev.ts || now, creator: null, sym: null, devBuy: 0, rsol: 0, late: 1, slot }; coins.set(ev.mint, c); }
  if (c.creator && ev.user === c.creator && ev.isBuy && !c.devBuy) c.devBuy = ev.sol;
  if (!c.trades) c.trades = [];
  c.trades.push({ t: ev.ts || now, w: ev.user, s: ev.isBuy ? 'b' : 's', sol: ev.sol, rsol: ev.rsol });
  const cut = now - 600000;
  while (c.trades.length && c.trades[0].t < cut) c.trades.shift();
  c.rsol = ev.rsol;
  buf.trades.push(JSON.stringify({ t: ev.ts || now, m: ev.mint, w: ev.user, s: ev.isBuy ? 'b' : 's', sol: ev.sol, tok: ev.token, rsol: ev.rsol, slot, sig }));
}

const RG = 85.0;
function snapshot() {
  const now = Date.now(); let n = 0;
  for (const [mint, c] of coins) {
    const age = (now - c.ts) / 1000;
    if (age > 1800) { if (age > 2400) coins.delete(mint); continue; }
    if (!c.trades || !c.trades.length) continue;
    const win = c.trades.filter(t => t.t > now - 90000);
    if (!win.length) continue;
    let bS = 0, sS = 0, nb = 0, ns = 0; const buyers = new Set(), bts = [];
    for (const t of win) { if (t.s === 'b') { nb++; bS += t.sol; buyers.add(t.w); bts.push(t.t); } else { ns++; sS += t.sol; } }
    bts.sort(); let burst = 0;
    for (let i = 1; i < bts.length; i++) if (bts[i] - bts[i - 1] <= 250) burst++;
    const ab = new Set(c.trades.filter(t => t.s === 'b').map(t => t.w));
    const as = new Set(c.trades.filter(t => t.s === 's').map(t => t.w));
    let ov = 0; for (const w of ab) if (as.has(w)) ov++;
    const old = c.trades.filter(t => t.t <= now - 60000).pop();
    const r0 = old ? old.rsol : c.trades[0].rsol;
    const pr = Math.max(0, c.rsol / RG * 100);
    n++;
    buf.snaps.push(JSON.stringify({ t: now, mint, age: Math.round(age), prog: +pr.toFixed(2), rsol: +c.rsol.toFixed(6),
      slope: +Math.min(60, pr - Math.max(0, r0 / RG * 100)).toFixed(2), buys: nb, sells: ns,
      buySol: +bS.toFixed(4), sellSol: +sS.toFixed(4), net: +(bS - sS).toFixed(4), uniq: buyers.size,
      ratio: ns ? +(nb / ns).toFixed(2) : nb, burst: bts.length > 1 ? +(burst / (bts.length - 1)).toFixed(3) : 0,
      neverSold: ab.size ? +(1 - ov / ab.size).toFixed(3) : 0, devBuy: +(c.devBuy || 0).toFixed(4), sym: c.sym, creator: c.creator, late: c.late || 0 }));
  }
  return n;
}

let ws = null, epIdx = 0, lastMsg = Date.now(), msgSinceConnect = 0, gen = 0;
function connect() {
  const my = ++gen;   // 连接代次：旧 socket 迟到的回调全部丢弃
  const url = WS_POOL[epIdx % WS_POOL.length];
  stat.conns++;
  try { ws = new WebSocket(url); } catch (e) { logf('连接异常 ' + e.message); setTimeout(connect, 2000); return; }
  ws.onopen = () => {
    if (my !== gen) return;
    msgSinceConnect = 0;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }));
    logf(`[+${((Date.now() - stat.started) / 1000).toFixed(0)}s] 连接#${stat.conns} ${url}`);
  };
  ws.onmessage = (m) => {
    if (my !== gen) return;
    lastMsg = Date.now(); msgSinceConnect++;
    let d; try { d = JSON.parse(m.data); } catch { return; }
    const v = d?.params?.result?.value;
    if (!v || !Array.isArray(v.logs)) return;
    stat.notes++;
    if (v.err) return;
    if (seenSig.has(v.signature)) return;
    seenSig.add(v.signature); if (seenSig.size > 300000) seenSig.clear();
    for (const line of v.logs) {
      if (line.charCodeAt(0) !== 80 || !line.startsWith('Program data: ')) continue;
      let b; try { b = Buffer.from(line.slice(14), 'base64'); } catch { continue; }
      onEvent(parseData(b), v.slot, v.signature);
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => { if (my !== gen) return; epIdx++; setTimeout(() => { if (my === gen) connect(); }, 1200); };
}
connect();

let lastSnap = 0, lastFlush = 0, lastLog = 0, snaps = 0;
const tick = setInterval(() => {
  const now = Date.now();
  if (now - lastFlush > 700) { flush(); lastFlush = now; }
  if (now - lastSnap > 30000) { snaps += snapshot(); lastSnap = now; }   // 30s 一次即可，回测主要用 trades 重算
  // 看门狗：12 秒没有任何消息 → 主动断开换端点（公共 RPC 会静默限流）
  if (now - lastMsg > 12000) {
    lastMsg = now; gen++;
    const old = ws; ws = null;
    if (old) { try { old.onopen = old.onmessage = old.onerror = old.onclose = null; old.close(); } catch {} }
    epIdx++; stat.conns++;
    logf(`↻ 静默重连 → ${WS_POOL[epIdx % WS_POOL.length]}`);
    connect();
  }
  if (now - lastLog > 20000) {
    lastLog = now;
    const el = (now - stat.started) / 1000;
    logf(`[+${el.toFixed(0)}s] 连接#${stat.conns} 通知${stat.notes} 成交${stat.trades} 非SOL${stat.nonSol||0} 新币${stat.creates} 毕业${stat.completes} 追踪${coins.size} 快照${snaps}`);
  }
}, 250);

setTimeout(() => {
  clearInterval(tick); flush();
  logf('===== 结束 ===== ' + JSON.stringify(stat));
  try { ws.close(); } catch {}
  process.exit(0);
}, SECONDS * 1000);
