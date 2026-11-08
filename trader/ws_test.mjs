// WebSocket 稳定性测试：订阅 pump 程序日志，统计每秒通知数与断流情况
import { WSS_POOL } from './rpc.mjs';

const URL_WS = WSS_POOL[0];
const SECS = Number(process.argv[2] || 70);
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const mask = (u) => u.replace(/api-key=([^&]{6})[^&]*([^&]{4})/, 'api-key=$1…$2');

let n = 0, errN = 0, okN = 0, drops = 0, reconnects = 0;
let lastMsg = Date.now();
const perSec = {};
const t0 = Date.now();

console.log(`连接 ${mask(URL_WS)}`);

function connect() {
  const ws = new WebSocket(URL_WS);
  let subbed = false;
  ws.onopen = () => {
    console.log(`  ✅ WS 已连接 (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'confirmed' }] }));
  };
  ws.onmessage = (m) => {
    lastMsg = Date.now();
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.result !== undefined && !subbed) { subbed = true; console.log(`  ✅ 订阅成功 id=${d.result}`); return; }
    const v = d?.params?.result?.value;
    if (!v) return;
    n++;
    if (v.err) errN++; else okN++;
    const s = Math.floor((Date.now() - t0) / 1000);
    perSec[s] = (perSec[s] || 0) + 1;
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    drops++;
    if (Date.now() - t0 < SECS * 1000) {
      reconnects++;
      console.log(`  ⚠️ 断线，重连 (${reconnects})`);
      setTimeout(connect, 1000);
    }
  };
}

// 看门狗：12 秒无消息 = 静默断流
const wd = setInterval(() => {
  if (Date.now() - lastMsg > 12000 && Date.now() - t0 < SECS * 1000) {
    console.log(`  ⚠️ 静默 ${((Date.now() - lastMsg) / 1000).toFixed(0)}s，强制重连`);
    lastMsg = Date.now();
    try { process.exit(9); } catch {}
  }
}, 2000);

connect();

setTimeout(() => {
  clearInterval(wd);
  const secs = (Date.now() - t0) / 1000;
  const keys = Object.keys(perSec).map(Number).sort((a, b) => a - b);
  const counts = keys.map(k => perSec[k]);
  const active = counts.filter(c => c > 0).length;
  const gaps = [];
  for (let i = 1; i < keys.length; i++) if (keys[i] - keys[i - 1] > 2) gaps.push(`${keys[i - 1]}s→${keys[i]}s`);
  console.log(`\n===== WS 测试结果（${secs.toFixed(0)} 秒）=====`);
  console.log(`通知总数 ${n}  成功 ${okN}  失败交易 ${errN}`);
  console.log(`平均 ${(n / secs).toFixed(1)} 条/秒   峰值 ${Math.max(...counts)} 条/秒   有数据的秒数 ${active}/${Math.round(secs)}`);
  console.log(`断线 ${drops} 次、重连 ${reconnects} 次`);
  if (gaps.length) console.log(`⚠️ 空洞: ${gaps.slice(0, 6).join(', ')}${gaps.length > 6 ? ` 等 ${gaps.length} 处` : ''}`);
  else console.log('✅ 无空洞，全程连续推送');
  const verdict = (drops === 0 && active / secs > 0.85 && n > 100);
  console.log(verdict ? '\n✅ 结论：这条 WS 可以用于实盘（稳定、连续）' : '\n⚠️ 结论：仍不稳定，需要加看门狗/换端点');
  process.exit(0);
}, SECS * 1000);
