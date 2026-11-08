# -*- coding: utf-8 -*-
"""离线回测引擎 v2：用采集到的真实 tick 重放 pumpfun v3.3
核心输出：
  A. 真实市场基本面（与策略无关，样本足够就有统计意义）
  B. 每个币在"首次符合入场区间"时的评分 → 之后按出场规则的真实收益 → 按评分分桶
     ← 这一项才回答"评分到底有没有预测力"
  C. 通过全部闸门的交易逐笔明细
成本：曲线 1.25%/边 + 真实冲击 + 优先费 0.0005×2 + ATA 0.00204（可开关）
"""
import json, math, os, sys, statistics as st
from collections import Counter

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
Y0, X0 = 1.073e9, 30.0
K = X0 * Y0
FEE = 0.0125
r = 1 - FEE
RG = 85.0

def price(R): return (X0 + R) ** 2 / K
def buy_tokens(R, d): return K / (X0 + R) - K / (X0 + R + d * r)
def sell_sol(R, h):
    if h <= 0 or R <= 0: return 0.0
    vtok = K / (X0 + R)
    return max(0.0, min(((X0 + R) - K / (vtok + h)) * r, R))
def prog(R): return max(0.0, min(300.0, R / RG * 100))

P = dict(size=0.2, minAge=45, maxAge=1800, minProg=10.0, maxProg=60.0,
         minScore=62, goodSlope=5, goodNet=3, goodBuyers=10, minBuyers=8, minSlope=1.5,
         win=90.0, tp1=0.40, tp1pct=0.50, trail=0.25, stop=0.25, stale=180, staleG=0.05,
         be=0.30, rug=0.40, hold=420, exitProg=95.0, prio=0.0005, ata=0.00204, ataReclaim=True)

def load(name):
    p = os.path.join(D, name)
    out = []
    if not os.path.exists(p): return out
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if line:
            try: out.append(json.loads(line))
            except: pass
    return out

coins = {c["mint"]: c for c in load("coins.jsonl")}
trades = load("trades.jsonl")
print(f"载入：新币(有创建事件) {len(coins)} 个，成交 {len(trades)} 笔")
if not trades:
    print("没数据，先跑 collector.mjs"); sys.exit(0)

by = {}
for t in trades:
    if not (t.get("sol", 0) > 0): continue
    by.setdefault(t["m"], []).append(t)
for v in by.values(): v.sort(key=lambda x: x["t"])

tmin, tmax = min(t["t"] for t in trades), max(t["t"] for t in trades)
span = (tmax - tmin) / 1000 / 60

print("=" * 100)
print(f"A. 真实市场基本面（覆盖 {span:.1f} 分钟，{len(by)} 个币有成交）")
sizes = sorted(t["sol"] for t in trades if t["sol"] > 0)
def q(a, p): return a[min(len(a) - 1, int(len(a) * p))]
print(f"   单笔成交额(SOL): p50={q(sizes,.5):.4f} p90={q(sizes,.9):.4f} p99={q(sizes,.99):.4f}")
reached = Counter()
for m, v in by.items():
    mx = max(prog(t["rsol"]) for t in v)
    for th in (2, 5, 10, 20, 40, 60, 85):
        if mx >= th: reached[th] += 1
print("   到达率: " + "  ".join(f"≥{th}%:{reached[th]/len(by)*100:4.1f}%" for th in (2, 5, 10, 20, 40, 60, 85)))
life = sorted((v[-1]["t"] - v[0]["t"]) / 1000 for v in by.values())
print(f"   成交活跃时长(秒): p50={q(life,.5):.0f} p90={q(life,.9):.0f} p99={q(life,.99):.0f}")

def features(v, i, t0):
    win = [x for x in v[:i + 1] if x["t"] > t0 - P["win"] * 1000]
    if not win: return None
    bs = ss = 0.0; nb = ns = 0; buyers = set(); sellers = set(); bts = []
    for x in win:
        if x["s"] == "b": nb += 1; bs += x["sol"]; buyers.add(x["w"]); bts.append(x["t"])
        else: ns += 1; ss += x["sol"]; sellers.add(x["w"])
    allb = {x["w"] for x in v[:i + 1] if x["s"] == "b"}
    alls = {x["w"] for x in v[:i + 1] if x["s"] == "s"}
    bts.sort()
    burst = sum(1 for k in range(1, len(bts)) if bts[k] - bts[k - 1] <= 250) / (len(bts) - 1) if len(bts) > 1 else 0
    old = [x for x in v[:i + 1] if x["t"] <= t0 - 60000]
    R0 = old[-1]["rsol"] if old else v[0]["rsol"]
    slope = min(60.0, prog(v[i]["rsol"]) - prog(R0))
    return dict(buys=nb, sells=ns, buySol=bs, sellSol=ss, net=bs - ss, uniq=len(buyers),
                ratio=(nb / ns if ns else nb), growth=1.0, slope=slope, burst=burst,
                neverSold=(1 - len(allb & alls) / len(allb)) if allb else 0)

def score(f, top10=40.0):
    c = lambda x: max(0.0, min(1.0, x if x == x else 0))
    parts = dict(slope=c(f["slope"] / P["goodSlope"]) * 25, net=c(f["net"] / P["goodNet"]) * 20,
                 buyers=c(f["uniq"] / P["goodBuyers"]) * 20, ratio=c((f["ratio"] - 1) / 1.5) * 10,
                 growth=c(f["growth"]) * 10, spread=(1 - c((top10 - 35) / 35)) * 15)
    return sum(parts.values()), parts

def simulate_exit(v, i0, tokens, t_entry):
    held, basis, realized = tokens, P["size"], 0.0
    tp1 = False; peak = 0.0; maxpnl = 0.0; why = "数据结束"
    j = i0; t = t_entry; lastP = price(v[i0]["rsol"]); end_t = v[-1]["t"]
    while True:
        t += 2000
        if t > end_t:
            realized += sell_sol(v[-1]["rsol"], held); why = "数据截断(按最后价)"; break
        while j + 1 < len(v) and v[j + 1]["t"] <= t: j += 1
        R = v[j]["rsol"]; p = price(R)
        if R >= RG * P["exitProg"] / 100:
            realized += sell_sol(RG * P["exitProg"] / 100, held); why = "毕业前退出"; break
        val = sell_sol(R, held); pnl = val / basis - 1
        if not tp1: peak = max(peak, val)
        dd = (1 - val / peak) if peak > 0 else 0
        if lastP > 0 and (1 - p / lastP) >= P["rug"]:
            realized += val; why = "砸盘紧急"; break
        if not tp1 and pnl >= P["tp1"]:
            part = int(held * P["tp1pct"]); realized += sell_sol(R, part); held -= part
            tp1 = True; peak = sell_sol(R, held); why = "止盈后超时"; lastP = p; continue
        maxpnl = max(maxpnl, pnl)
        if not tp1 and maxpnl >= P["be"] and pnl <= 0: realized += val; why = "保本"; break
        if pnl <= -P["stop"]: realized += val; why = "止损"; break
        if tp1 and dd >= P["trail"]: realized += val; why = "移动止损"; break
        if not tp1 and (t - t_entry) / 1000 >= P["stale"] and pnl < P["staleG"]: realized += val; why = "无动能"; break
        if (t - t_entry) / 1000 >= P["hold"]: realized += val; why = "持仓超时"; break
        lastP = p
    fixed = 2 * P["prio"] + 2 * 0.000005 + (0 if P["ataReclaim"] else P["ata"])
    return (realized - fixed) / basis - 1, why

print("=" * 100)
print("B. 评分预测力检验：每个币在【首次】满足 币龄≥100s 且 进度10~60% 时打分，再按出场规则模拟")
cands = []
for mint, v in by.items():
    c = coins.get(mint)
    t_birth = (c or {}).get("ts") or v[0]["t"]
    for i in range(len(v)):
        age = (v[i]["t"] - t_birth) / 1000
        if age < P["minAge"]: continue
        if age > P["maxAge"]: break
        pr = prog(v[i]["rsol"])
        if pr < P["minProg"] or pr > P["maxProg"]: continue
        f = features(v, i, v[i]["t"])
        if not f: continue
        sc, parts = score(f)
        tok = buy_tokens(v[i]["rsol"], P["size"])
        ret, why = simulate_exit(v, i, tok, v[i]["t"])
        cands.append(dict(mint=mint, sym=(c or {}).get("sym"), age=round(age), prog=round(pr, 1),
                          score=round(sc, 1), parts=parts, ret=ret, why=why, born=bool(c), **f))
        break

print(f"   候选池（首次进入区间）: {len(cands)} 个币")
if cands:
    print(f"   {'评分档':<10} {'样本':>4} {'均值':>9} {'中位':>9} {'胜率':>6} {'最差':>9} {'最好':>9}")
    bands = ((0, 40), (40, 60), (60, 70), (70, 80), (80, 101))
    means = []
    for lo, hi in bands:
        rows = [x["ret"] for x in cands if lo <= x["score"] < hi]
        if not rows: print(f"   {f'{lo}~{hi}':<10} {0:>4}"); continue
        means.append(st.mean(rows))
        print(f"   {f'{lo}~{hi}':<10} {len(rows):>4} {st.mean(rows)*100:>8.1f}% {st.median(rows)*100:>8.1f}% "
              f"{sum(1 for x in rows if x > 0)/len(rows)*100:>5.0f}% {min(rows)*100:>8.1f}% {max(rows)*100:>8.1f}%")
    mono = len(means) >= 2 and all(means[i] <= means[i+1] for i in range(len(means)-1))
    print(f"   单调性: {'✅ 递增' if mono else '❌ 不单调/样本不足'}  {[round(m*100,1) for m in means]}")

    # ── 阈值扫描：用真实候选池的分数分布反推 minScore ──
    sc = sorted(x["score"] for x in cands)
    def pctl(p): return sc[min(len(sc) - 1, int(len(sc) * p))]
    print(f"\n   候选池评分分布: min={sc[0]:.0f} p25={pctl(.25):.0f} p50={pctl(.5):.0f} p75={pctl(.75):.0f} p90={pctl(.9):.0f} max={sc[-1]:.0f}")
    rate = len(cands) / max(1e-9, span) * 60 * 24        # 候选/天
    print(f"   候选产出率 ≈ {len(cands)} 个 / {span:.1f} 分钟 ≈ {rate:.0f} 个/天")
    print(f"   {'minScore':>9} {'通过数':>6} {'占比':>7} {'≈笔/天':>8} {'通过者均值':>10} {'通过者胜率':>10}")
    for th in (50, 55, 60, 65, 70, 75, 80, 85, 90):
        sel = [x["ret"] for x in cands if x["score"] >= th]
        if sel:
            print(f"   {th:>9} {len(sel):>6} {len(sel)/len(cands)*100:>6.1f}% {rate*len(sel)/len(cands):>8.0f} "
                  f"{st.mean(sel)*100:>9.1f}% {sum(1 for r in sel if r>0)/len(sel)*100:>9.0f}%")
        else:
            print(f"   {th:>9} {0:>6} {0.0:>6.1f}% {0:>8} {'—':>10} {'—':>10}")
    # 目标：每天 10~50 笔 → 通过率 = 目标笔数 / 候选率
    print(f"\n   若目标 {10}~{50} 笔/天，需要从 {rate:.0f} 个/天的候选里取 {10/max(rate,1)*100:.1f}%~{50/max(rate,1)*100:.1f}%")
    print(f"   → 对应 minScore ≈ 第 {100-50/max(rate,1)*100:.0f} ~ {100-10/max(rate,1)*100:.0f} 百分位，即 ≈ {pctl(max(0,1-50/max(rate,1))):.0f} ~ {pctl(max(0,1-10/max(rate,1))):.0f} 分")

print("=" * 100)
print(f"C. 通过全部闸门（评分≥{P['minScore']} + 买家≥{P['minBuyers']} + 非对倒）的逐笔")
ok = [x for x in cands if x["score"] >= P["minScore"] and x["uniq"] >= P["minBuyers"]
      and not (x["burst"] >= 0.85 and x["neverSold"] >= 0.85)]
if not ok:
    print("   0 笔 —— 样本内没有币同时满足 v3.3 的全部闸门（15 分钟样本量限制）")
else:
    rs = sorted(x["ret"] for x in ok)
    print(f"   {len(ok)} 笔 | 均值 {st.mean(rs)*100:+.1f}% 中位 {st.median(rs)*100:+.1f}% "
          f"胜率 {sum(1 for x in rs if x>0)/len(rs)*100:.0f}% | 出场 {dict(Counter(x['why'] for x in ok))}")
    for x in sorted(ok, key=lambda y: -y["ret"]):
        print(f"   {str(x['sym'])[:12]:<12} 币龄{x['age']:>4}s 进度{x['prog']:>5.1f}% 评分{x['score']:>5.1f} "
              f"净流{x['net']:>6.2f} 买家{x['uniq']:>3} 比{x['ratio']:>4.2f} → {x['ret']*100:+7.1f}% ({x['why']})")

print(f"\n注：样本仅 {span:.0f} 分钟，用于验证管线与闸门是否按预期工作，不足以判断策略优劣。")
print("    统计显著（σ≈40%，识别 +5%/笔）需 N≈254 笔；按每天 10~50 笔，需连续采 5~25 天。")
