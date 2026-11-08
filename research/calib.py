# -*- coding: utf-8 -*-
"""阈值标定器：用采集到的真实 tick，输出候选池的特征分布 + 建议的 minScore / minBuyers
用法: python calib.py [minAge] [minProg] [maxProg]
"""
import json, math, os, sys, statistics as st

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
Y0, X0 = 1.073e9, 30.0
K = X0 * Y0; r = 1 - 0.0125; RG = 85.0
def prog(R): return max(0.0, min(300.0, R / RG * 100))
MINAGE = float(sys.argv[1] if len(sys.argv) > 1 else 100)
MINP = float(sys.argv[2] if len(sys.argv) > 2 else 10)
MAXP = float(sys.argv[3] if len(sys.argv) > 3 else 60)
WIN = 90.0
GOOD = dict(slope=5, net=3, buyers=10)

def load(n):
    p = os.path.join(D, n)
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []

coins = {c["mint"]: c for c in load("coins.jsonl")}
trades = load("trades.jsonl")
by = {}
for t in trades: by.setdefault(t["m"], []).append(t)
for v in by.values(): v.sort(key=lambda x: x["t"])
span = (max(t["t"] for t in trades) - min(t["t"] for t in trades)) / 60000

def features(v, i, t0):
    w = [x for x in v[:i + 1] if x["t"] > t0 - WIN * 1000]
    if not w: return None
    bs = ss = 0.0; nb = ns = 0; bu = set(); se = set(); bts = []
    for x in w:
        if x["s"] == "b": nb += 1; bs += x["sol"]; bu.add(x["w"]); bts.append(x["t"])
        else: ns += 1; ss += x["sol"]; se.add(x["w"])
    ab = {x["w"] for x in v[:i + 1] if x["s"] == "b"}; asl = {x["w"] for x in v[:i + 1] if x["s"] == "s"}
    bts.sort()
    burst = sum(1 for k in range(1, len(bts)) if bts[k] - bts[k-1] <= 250) / (len(bts) - 1) if len(bts) > 1 else 0
    old = [x for x in v[:i + 1] if x["t"] <= t0 - 60000]
    R0 = old[-1]["rsol"] if old else v[0]["rsol"]
    return dict(buys=nb, sells=ns, buySol=bs, sellSol=ss, net=bs - ss, uniq=len(bu),
                ratio=(nb/ns if ns else nb), growth=1.0,
                slope=min(60.0, prog(v[i]["rsol"]) - prog(R0)), burst=burst,
                neverSold=(1 - len(ab & asl) / len(ab)) if ab else 0)

def score(f, top10=40.0):
    c = lambda x: max(0.0, min(1.0, x if x == x else 0))
    return (c(f["slope"]/GOOD["slope"])*25 + c(f["net"]/GOOD["net"])*20 + c(f["uniq"]/GOOD["buyers"])*20
            + c((f["ratio"]-1)/1.5)*10 + c(f["growth"])*10 + (1-c((top10-35)/35))*15)

cands = []
for m, v in by.items():
    c = coins.get(m); tb = (c or {}).get("ts") or v[0]["t"]
    for i in range(len(v)):
        age = (v[i]["t"] - tb) / 1000
        if age < MINAGE: continue
        if age > 1800: break
        pr = prog(v[i]["rsol"])
        if pr < MINP or pr > MAXP: continue
        f = features(v, i, v[i]["t"])
        if not f: continue
        cands.append((m, age, pr, score(f), f))
        break

print(f"样本 {span:.1f} 分钟 | 有创建事件的币 {len(coins)} | 有成交的币 {len(by)} | 候选池 {len(cands)}")
if not cands:
    print("候选池为空"); sys.exit(0)
print("\n候选池特征分布（90 秒窗）")
for k in ("uniq", "net", "slope", "ratio", "buys", "sells", "burst", "neverSold"):
    a = sorted(c[4][k] for c in cands); n = len(a)
    print(f"  {k:<10} p10={a[int(n*.1)]:8.2f} p25={a[int(n*.25)]:8.2f} p50={a[n//2]:8.2f} p75={a[int(n*.75)]:8.2f} p90={a[int(n*.9)]:8.2f} max={a[-1]:8.2f}")

sc = sorted(c[3] for c in cands); n = len(sc)
print(f"\n评分分布: p10={sc[int(n*.1)]:.0f} p50={sc[n//2]:.0f} p75={sc[int(n*.75)]:.0f} p90={sc[int(n*.9)]:.0f} p98={sc[min(n-1,int(n*.98))]:.0f} max={sc[-1]:.0f}")
rate = len(cands) / max(span, 1e-9) * 60 * 24
print(f"候选产出 ≈ {rate:.0f} 个/天")
print(f"\n{'目标笔/天':>10} {'需通过率':>9} {'建议 minScore':>14} {'建议 minBuyers':>15}")
for target in (5, 10, 20, 50, 100):
    frac = min(1.0, target / max(rate, 1e-9))
    q = sc[min(n - 1, int(n * (1 - frac)))]
    ub = sorted(c[4]["uniq"] for c in cands)
    ubuy = ub[min(n - 1, int(n * (1 - frac)))]
    print(f"{target:>10} {frac*100:>8.1f}% {q:>14.0f} {ubuy:>15.0f}")

print("\n候选明细（按评分降序）")
print(f"{'sym':<14}{'age':>5}{'prog':>7}{'score':>7}{'uniq':>6}{'net':>8}{'slope':>7}{'ratio':>7}{'burst':>7}{'不卖':>6}")
for m, age, pr, s, f in sorted(cands, key=lambda x: -x[3]):
    print(f"{str(coins.get(m, {}).get('sym'))[:13]:<14}{age:>5.0f}{pr:>7.1f}{s:>7.1f}{f['uniq']:>6}{f['net']:>8.2f}{f['slope']:>7.1f}{f['ratio']:>7.2f}{f['burst']:>7.2f}{f['neverSold']:>6.2f}")
