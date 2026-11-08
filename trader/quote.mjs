// 真实报价器：直接读链上 bonding curve，算买入成本/滑点/往返损耗（不需要私钥）
// 用法: node quote.mjs <mint> [投入SOL]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = require('@pump-fun/pump-sdk');

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const mintArg = process.argv[2];
const budgetSol = Number(process.argv[3] || 0.05);
if (!mintArg) { console.error('用法: node quote.mjs <mint> [投入SOL]'); process.exit(1); }

const L = 1_000_000_000;
const sol = (bn) => Number(bn.toString()) / L;
const tok = (bn) => Number(bn.toString()) / 1e6;
const conn = new Connection(RPC, 'confirmed');
const online = new OnlinePumpSdk(conn);
const mint = new PublicKey(mintArg);
const CFG = (() => { try { return require('./config.json'); } catch { return {}; } })();
const user = new PublicKey(process.env.WALLET || CFG.wallet || 'AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU');

const st = await online.fetchBuyState(mint, user);
const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
const qargs = { global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve,
  quoteMint: st.quoteMint, quoteControl: null, creatorFeeBps: st.bondingCurve.creatorFeeBps,
  pumpQuote: null, quoteTransferFee: st.quoteTransferFee };
const bc = st.bondingCurve;
if (bc.complete) { console.log('已毕业（迁移到 PumpSwap），内盘路径不可用'); process.exit(0); }
const vq = sol(bc.virtualQuoteReserves), rq = sol(bc.realQuoteReserves), vt = tok(bc.virtualTokenReserves);
const progress = rq / 85 * 100;
console.log(`\n=== 链上状态 ${mintArg.slice(0,10)}… ===`);
console.log(`  曲线进度  ${progress.toFixed(2)}%   (真实储备 ${rq.toFixed(4)} / 85 SOL)`);
console.log(`  虚拟储备  ${vq.toFixed(4)} SOL / ${vt.toFixed(1)} M 代币`);
console.log(`  创作者    ${bc.creator.toBase58()}`);
console.log(`  可能标志  mayhem=${bc.isMayhemMode}  cashback=${bc.isCashbackCoin}  creatorFeeBps=${bc.creatorFeeBps.toString()}`);

const budget = new BN(Math.round(budgetSol * L));
const tokens = getBuyTokenAmountFromSolAmount({ ...qargs, amount: budget });
const back = getSellSolAmountFromTokenAmount({ ...qargs, amount: tokens });
if (Number(tokens.toString()) === 0) { console.log('报价为 0（储备不足/参数不符）'); process.exit(0); }

const priceBefore = vq / vt;
const priceAfter = (vq + budgetSol) / (vt - tok(tokens));
console.log(`\n=== 买入 ${budgetSol} SOL ===`);
console.log(`  得到代币   ${tok(tokens).toFixed(3)} 万? → ${(tok(tokens)/1e4).toFixed(2)} 万枚 (${(tok(tokens)).toLocaleString()} 枚)`);
console.log(`  成交均价   ${(budgetSol / tok(tokens) * 1e6).toExponential(3)} lamport/枚   边际价 ${(priceBefore * 1e6).toExponential(3)}`);
console.log(`  价格冲击   ${((priceAfter / priceBefore - 1) * 100).toFixed(3)}%`);
console.log(`  立刻卖回   ${sol(back).toFixed(6)} SOL   纯曲线往返损耗 ${((1 - sol(back) / budgetSol) * 100).toFixed(2)}%`);

const FEE = { prio: 0.0005, base: 0.000005, ata: 0.00204 };
const fixed = 2 * FEE.prio + 2 * FEE.base + FEE.ata;
const total = (1 - sol(back) / budgetSol) * budgetSol + fixed;
console.log(`\n=== 含真实固定成本（优先费${FEE.prio}×2 + 签名费 + ATA租金${FEE.ata}）===`);
console.log(`  往返总损耗 ${(total / budgetSol * 100).toFixed(2)}%   (${total.toFixed(6)} SOL)`);
console.log(`  → 起跑线：必须涨 ${(total / budgetSol * 100).toFixed(2)}% 才回本；ATA 回收后 ${((total - FEE.ata) / budgetSol * 100).toFixed(2)}%`);

try {
  const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user, amount: tokens, solAmount: budget, slippage: 5 });
  const lastIx = ixs[ixs.length - 1];
  console.log(`\n=== 指令构造验证（不发出去）===`);
  console.log(`  共 ${ixs.length} 条指令`);
  ixs.forEach((ix, i) => console.log(`   ${i + 1}. program ${ix.programId.toBase58().slice(0,8)}…  账户 ${ix.keys.length}  数据 ${ix.data.length}B  ${ix.data.subarray(0,8).toString('hex')}`));
} catch (e) {
  console.log('\n指令构造失败:', e.message.slice(0, 300));
}
