# -*- coding: utf-8 -*-
"""漏斗分析：按"策略真正会动手的那一刻"定义候选（进度带 + 币龄 + 独立买家≥N），
输出漏斗、评分分布与真实收益，用来定 pMinBuyers / pMinScore。"""
import json, math, os, sys, statistics as st

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
Y0, X0, RG = 1.073e9, 30.0, 85.0
K = X0 * Y0
r = 1 - 0.0125
price = lambda R: (X0 + R) ** 2 / K
prog = lambda R: max(0.0, min(300.0, R / RG * 100))
def buy_tokens(R, d): return K / (X0 + R) - K / (X0 + R + d * r)
def sell_sol(R, h):
    if h <= 0 or R <= 0: return 0.0
    vtok = K / (X0 + R)
    return max(0.0, min(((X0 + R) - K / (vtok + h)) * r, R))

P = dict(size=0.2, tp1=.40, tp1pct=.50, trail=.25, stop=.25, stale=180, staleG=0.05,
         be=.30, rug=.40, hold=420, exitProg=95.0, prio=0.0005)
GOOD = dict(slope=5, net=3, buyers=10)

def load(n):
    p = os.path.join(D, n)
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []

coins = {c["mint"]: c for c in load("coins.jsonl")}
trades = load("trades.jsonl")
by = {}
for t in trades:
    if not (t.get("sol", 0) > 0): continue
    by.setdefault(t["m"], []).append(t)
for v in by.values(): v.sort(key=lambda x: x["t"])
span = (max(t["t"] for t in trades) - min(t["t"] for t in trades)) / 60000

def features(v, i, t0, win=90.0):
    w = [x for x in v[:i + 1] if x["t"] > t0 - win * 1000]
    if not w: return None
    bs = ss = 0.0; nb = ns = 0; bu = set(); bts = []
    for x in w:
        if x["s"] == "b": nb += 1; bs += x["sol"]; bu.add(x["w"]); bts.append(x["t"])
        else: ns += 1; ss += x["sol"]
    ab = {x["w"] for x in v[:i + 1] if x["s"] == "b"}; asl = {x["w"] for x in v[:i + 1] if x["s"] == "s"}
    bts.sort()
    burst = sum(1 for k in range(1, len(bts)) if bts[k] - bts[k-1] <= 250) / (len(bts) - 1) if len(bts) > 1 else 0
    old = [x for x in v[:i + 1] if x["t"] <= t0 - 60000]
    R0 = old[-1]["rsol"] if old else v[0]["rsol"]
    return dict(buys=nb, sells=ns, buySol=bs, sellSol=ss, net=bs - ss, uniq=len(bu),
                ratio=(nb/ns if ns else nb), growth=1.0, slope=min(60.0, prog(v[i]["rsol"]) - prog(R0)),
                burst=burst, neverSold=(1 - len(ab & asl) / len(ab)) if ab else 0)

def score(f, top10=40.0):
    c = lambda x: max(0.0, min(1.0, x if x == x else 0))
    return (c(f["slope"]/GOOD["slope"])*25 + c(f["net"]/GOOD["net"])*20 + c(f["uniq"]/GOOD["buyers"])*20
            + c((f["ratio"]-1)/1.5)*10 + c(f["growth"])*10 + (1-c((top10-35)/35))*15)

def sim_exit(v, i0, tokens, t_entry):
    held, basis, realized, tp1, peak, maxpnl = tokens, P["size"], 0.0, False, 0.0, 0.0
    j, t, lastP, end_t, why = i0, t_entry, price(v[i0]["rsol"]), v[-1]["t"], "数据结束"
    while True:
        t += 2000
        if t > end_t:
            realized += sell_sol(v[-1]["rsol"], held); why = "数据截断"; break
        while j + 1 < len(v) and v[j+1]["t"] <= t: j += 1
        R = v[j]["rsol"]; p = price(R)
        if R >= RG * P["exitProg"] / 100: realized += sell_sol(RG*P["exitProg"]/100, held); why = "毕业前退出"; break
        val = sell_sol(R, held); pnl = val / basis - 1
        if not tp1: peak = max(peak, val)
        dd = (1 - val/peak) if peak > 0 else 0
        if lastP > 0 and (1 - p/lastP) >= P["rug"]: realized += val; why = "砸盘紧急"; break
        if not tp1 and pnl >= P["tp1"]:
            part = int(held*P["tp1pct"]); realized += sell_sol(R, part); held -= part
            tp1 = True; peak = sell_sol(R, held); why = "止盈后超时"; lastP = p; continue
        maxpnl = max(maxpnl, pnl)
        if not tp1 and maxpnl >= P["be"] and pnl <= 0: realized += val; why = "保本"; break
        if pnl <= -P["stop"]: realized += val; why = "止损"; break
        if tp1 and dd >= P["trail"]: realized += val; why = "移动止损"; break
        if not tp1 and (t-t_entry)/1000 >= P["stale"] and pnl < P["staleG"]: realized += val; why = "无动能"; break
        if (t-t_entry)/1000 >= P["hold"]: realized += val; why = "持仓超时"; break
        lastP = p
    fixed = 2*P["prio"] + 2*0.000005 + 0.00204
    return (realized - fixed)/basis - 1, why

print(f"样本 {span:.1f} 分钟 | {len(by)} 个币有成交 | {len(coins)} 个捕获到创建事件")
print(f"漏斗：币龄≥100s 且 进度 10~60% 且 90 秒窗独立买家 ≥ N\n")
print(f"{'N':>4} {'达标币数':>8} {'占样本':>7} {'≈个/天':>8} {'评分中位':>9} {'评分max':>8} {'模拟均值':>9} {'胜率':>6}")
for N in (2, 3, 5, 8, 10, 12, 15, 20, 25):
    rows = []
    for m, v in by.items():
        c = coins.get(m); tb = (c or {}).get("ts") or v[0]["t"]
        for i in range(len(v)):
            age = (v[i]["t"] - tb) / 1000
            if age < 100: continue
            if age > 1800: break
            pr = prog(v[i]["rsol"])
            if pr < 10 or pr > 60: continue
            f = features(v, i, v[i]["t"])
            if not f or f["uniq"] < N: continue
            sc = score(f)
            ret, why = sim_exit(v, i, buy_tokens(v[i]["rsol"], P["size"]), v[i]["t"])
            rows.append((m, f, sc, ret, why, age, pr))
            break
    if not rows:
        print(f"{N:>4} {0:>8} {0.0:>6.1f}% {0:>8} {'—':>9} {'—':>8} {'—':>9} {'—':>6}")
        continue
    scs = sorted(x[2] for x in rows); rr = [x[3] for x in rows]
    per_day = len(rows)/span*60*24
    print(f"{N:>4} {len(rows):>8} {len(rows)/len(by)*100:>6.1f}% {per_day:>8.0f} {scs[len(scs)//2]:>9.1f} {scs[-1]:>8.1f} "
          f"{st.mean(rr)*100:>8.1f}% {sum(1 for x in rr if x>0)/len(rr)*100:>5.0f}%")

print("\n达标明细（N=5）：")
for m, v in by.items():
    c = coins.get(m); tb = (c or {}).get("ts") or v[0]["t"]
    for i in range(len(v)):
        age = (v[i]["t"] - tb)/1000
        if age < 100: continue
        if age > 1800: break
        pr = prog(v[i]["rsol"])
        if pr < 10 or pr > 60: continue
        f = features(v, i, v[i]["t"])
        if not f or f["uniq"] < 5: continue
        sc = score(f); ret, why = sim_exit(v, i, buy_tokens(v[i]["rsol"], P["size"]), v[i]["t"])
        print(f"  {str((c or {}).get('sym'))[:12]:<13} 币龄{age:>4.0f}s 进度{pr:>5.1f}% 评分{sc:>5.1f} "
              f"买家{f['uniq']:>2} 净流{f['net']:>6.2f} 斜率{f['slope']:>5.1f} 比{f['ratio']:>4.1f} → {ret*100:+7.1f}% ({why})")
        break

print("\n结论口径：")
print("  · 候选 = 币龄≥100s + 进度10~60% + 90秒窗独立买家≥N（与 psFlowCheck 同口径）")
print("  · '个/天' 是按本样本外推，样本仅 {:.0f} 分钟，误差很大，只用于判断量级".format(span))
