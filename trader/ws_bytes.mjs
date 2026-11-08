import { WSS_POOL } from './rpc.mjs';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SECS = 30;
let bytes = 0, n = 0, failed = 0, t0 = Date.now();
const ws = new WebSocket(WSS_POOL[0]);
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }));
ws.onmessage = (m) => {
  const len = typeof m.data === 'string' ? m.data.length : 0;
  bytes += len; n++;
  try { const d = JSON.parse(m.data); if (d?.params?.result?.value?.err) failed++; } catch {}
};
// 同时测一个「只收成功交易」的 Helius transactionSubscribe 做对比
let b2 = 0, n2 = 0;
const ws2 = new WebSocket(WSS_POOL[0]);
ws2.onopen = () => ws2.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'transactionSubscribe',
  params: [{ accountInclude: [PUMP], failed: false, vote: false }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'signatures', maxSupportedTransactionVersion: 0 }] }));
ws2.onmessage = (m) => { if (typeof m.data !== 'string') return; if (m.data.includes('"result"') && n2 === 0) return; b2 += m.data.length; n2++; };

setTimeout(() => {
  const s = (Date.now() - t0) / 1000;
  const mb = bytes / 1048576;
  const cr = mb / 0.1 * 2;
  console.log('=== logsSubscribe(全部日志) ===');
  console.log(`  ${n} 条 / ${s.toFixed(0)}s | ${(bytes / 1024 / s).toFixed(1)} KB/s | 失败交易 ${failed} (${(failed / n * 100).toFixed(0)}%)`);
  console.log(`  → ${(cr / s * 86400).toFixed(0)} credits/天  = 100万额度撑 ${(1e6 / (cr / s * 86400)).toFixed(1)} 天`);
  console.log('=== transactionSubscribe(仅成功交易, signatures) ===');
  console.log(`  ${n2} 条 / ${s.toFixed(0)}s | ${(b2 / 1024 / s).toFixed(1)} KB/s`);
  const cr2 = (b2 / 1048576) / 0.1 * 2;
  console.log(`  → ${(cr2 / s * 86400).toFixed(0)} credits/天  = 100万额度撑 ${(1e6 / (cr2 / s * 86400)).toFixed(1)} 天`);
  process.exit(0);
}, SECS * 1000);
