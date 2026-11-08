// 统一 RPC 入口：优先用 config.json 里配的 Helius，公共节点做降级备用
// 环境变量 SOLANA_RPC / SOLANA_WS 可临时覆盖（优先级最高）
import fs from 'node:fs';

const CFG = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

export const RPC_URL = process.env.SOLANA_RPC || CFG.rpc || 'https://api.mainnet-beta.solana.com';

// ---- WS：默认走免费公共节点 ----
// 原因（实测）：Helius 的 LaserStream WS 按流量计费 2 credits/0.1MB，
// logsSubscribe 收全量 pump 日志 = 377 KB/s ≈ 63.7 万 credits/天 → 免费档 1.6 天烧光；
// 而 transactionSubscribe（只收成功交易，流量小）免费档不支持。
// 所以：行情走免费公共 WS（实测 30s 0 断线），Helius 只用来做 HTTP 查询（1 credit/次）。
const FREE_WS = ['wss://solana-rpc.publicnode.com', 'wss://api.mainnet-beta.solana.com'];
const PAID_WS = CFG.wss ? [CFG.wss] : [];
const usePaid = CFG.preferPaidWs === true;

export const WSS_URL = process.env.SOLANA_WS
  || (usePaid && PAID_WS.length ? PAID_WS[0] : FREE_WS[0]);

// 主用在前，备用在后，自动去重
export const RPCS = [...new Set([
  RPC_URL,
  ...(CFG.rpcFallback || []),
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean))];

export const WSS_POOL = [...new Set([
  ...(usePaid ? PAID_WS : []),
  ...FREE_WS,
].filter(Boolean))];   // 注意：默认不含 Helius WS（按流量计费，377KB/s ≈ 63.7万 credits/天）

// 免费档 10 req/s —— 给调用方一个安全间隔（毫秒）
export const isHelius = /helius-rpc\.com/.test(RPC_URL);
export const SAFE_GAP_MS = isHelius ? 110 : 60;

export const describeRpc = () => {
  const m = RPC_URL.match(/api-key=([^&]+)/);
  const key = m ? m[1] : '';
  const shown = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '(无 key)';
  return `${RPC_URL.split('?')[0]} key=${shown} | 备用 ${RPCS.length - 1} 个`;
};
