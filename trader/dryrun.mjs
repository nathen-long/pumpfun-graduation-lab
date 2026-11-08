// dryrun：构造真实买入交易并在链上模拟，不签名、不发交易、不需要私钥
// 用法: node dryrun.mjs <mint> [投入SOL]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Connection, PublicKey, Transaction, ComputeBudgetProgram, VersionedTransaction, TransactionMessage, SystemProgram } = require('@solana/web3.js');
const BN = require('bn.js');
const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const mintArg = process.argv[2];
const budgetSol = Number(process.argv[3] || 0.05);
const CFG = (() => { try { return require('./config.json'); } catch { return {}; } })();
const WALLET = process.env.WALLET || CFG.wallet || 'AXnPU2KjJDxJXVB3z6xvYJ9UMMb7N4guiXdzZVqFxBVU';
if (!mintArg) { console.error('用法: node dryrun.mjs <mint> [投入SOL]'); process.exit(1); }

const L = 1_000_000_000;
const sol = (bn) => Number(bn.toString()) / L;
const conn = new Connection(RPC, 'confirmed');
const online = new OnlinePumpSdk(conn);
const mint = new PublicKey(mintArg);
const user = new PublicKey(WALLET);

const bal = await conn.getBalance(user);
console.log(`\n钱包 ${WALLET}`);
console.log(`余额 ${(bal / L).toFixed(6)} SOL  ${bal === 0 ? '⚠️ 空钱包，模拟会因为账户不存在而失败（转入 SOL 后即可）' : ''}`);

// 关键：pump 现在有 Token-2022 的币，ATA/token 指令必须用对应程序，否则 IncorrectProgramId
const TOKEN_2022_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const mintInfo = await conn.getAccountInfo(mint);
const tokenProgram = mintInfo && mintInfo.owner.equals(TOKEN_2022_ID) ? TOKEN_2022_ID : require('@solana/web3.js').TOKEN_PROGRAM_ID;
console.log(`代币程序 ${tokenProgram.toBase58() === TOKEN_2022_ID.toBase58() ? 'Token-2022' : '老 SPL'}`);

const st = await online.fetchBuyState(mint, user);
const bc = st.bondingCurve;
if (bc.complete) { console.log('该币已毕业，内盘不可买'); process.exit(0); }
const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
const budget = new BN(Math.round(budgetSol * L));
const tokens = getBuyTokenAmountFromSolAmount({
  global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: budget,
  quoteMint: st.quoteMint, quoteControl: null, creatorFeeBps: bc.creatorFeeBps, pumpQuote: null, quoteTransferFee: st.quoteTransferFee,
});
console.log(`目标币 ${mintArg.slice(0, 10)}…  进度 ${(sol(bc.realQuoteReserves) / 85 * 100).toFixed(2)}%`);
console.log(`计划买入 ${budgetSol} SOL → 约 ${(Number(tokens.toString()) / 1e6).toLocaleString()} 枚`);

// 组交易：优先费 + buy
const PRIO = Number(process.env.PRIO || 500_000);         // lamports
const CU = Number(process.env.CU || 150_000);
const ixs = await PUMP_SDK.buyInstructions({
  global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc,
  associatedUserAccountInfo: st.associatedUserAccountInfo,
  mint, user, amount: tokens, solAmount: budget, slippage: 5, tokenProgram,
});
const all = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: CU }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(PRIO * 1e6 / CU) }),
  ...ixs,
];
const { blockhash } = await conn.getLatestBlockhash('confirmed');
const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
const vtx = new VersionedTransaction(msg);

console.log(`\n交易：${all.length} 条指令 · 需要签名者 ${msg.header.numRequiredSignatures} 个（模拟用 sigVerify=false）`);
try {
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  if (sim.value.err) {
    console.log(`\n❌ 模拟失败: ${JSON.stringify(sim.value.err)}`);
    (sim.value.logs || []).slice(-8).forEach(l => console.log('   ' + l));
    if (bal === 0) console.log('\n原因：钱包余额 0，fee payer 账户在链上不存在。转入 SOL 后再跑。');
  } else {
    console.log(`\n✅ 模拟成功`);
    console.log(`  消耗计算单元 ${sim.value.unitsConsumed}`);
    console.log(`  优先费 ≈ ${(PRIO / L).toFixed(6)} SOL   签名费 0.000005 SOL   预算总费用 ≈ ${((PRIO + 5000) / L).toFixed(6)} SOL`);
    console.log(`  账户写入/租金见日志：`);
    (sim.value.logs || []).slice(-6).forEach(l => console.log('   ' + l));
    // 从日志里解析实际到账代币数
    for (const l of sim.value.logs || []) {
      const m = l.match(/Instruction: Buy.*?amount:\s*(\d+)/i);
      if (m) console.log(`  日志中的买入数量: ${Number(m[1]) / 1e6}`);
    }
  }
} catch (e) {
  console.log('\n模拟调用异常:', String(e.message).slice(0, 300));
  if (bal === 0) console.log('（钱包余额 0，先充一点 SOL 再试）');
}
