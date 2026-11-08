#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纸面引擎日报生成器
  python grad_report.py           生成今天
  python grad_report.py 2026-11-06 生成指定日期
输出：reports/grad_YYYY-MM-DD.md
"""
import os
import sys
import json
import statistics
from datetime import datetime, timedelta, timezone
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(ROOT, "logs")
GRAD = os.path.join(ROOT, "data", "grad")
REPORTS = os.path.join(ROOT, "reports")
TZ = timezone(timedelta(hours=8))


def daykey():
    return datetime.now(TZ).strftime("%Y-%m-%d")


def load_trades(day):
    """优先取归档，其次取实时文件（只看当天的记录）"""
    out = []
    for p in (os.path.join(GRAD, tag, day, "trades.jsonl"), os.path.join(LOGS, f"graduation_trades_{tag}.jsonl")):
        if not os.path.exists(p):
            continue
        for line in open(p, encoding="utf-8", errors="ignore"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = r.get("t", 0) / 1000
            d = datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d") if t > 0 else ""
            if d == day:
                out.append(r)
        if out:
            break
    out.sort(key=lambda r: r.get("t", 0))
    return out


def pct(x, n=1):
    return f"{x * 100:+.{n}f}%"


def build(day=None, tag='confirm'):
    day = day or daykey()
    os.makedirs(REPORTS, exist_ok=True)
    trades = load_trades(day)
    buys = [r for r in trades if r.get("side") == "buy"]
    sells = [r for r in trades if r.get("side") == "sell"]

    led = {}
    lp = os.path.join(GRAD, f"ledger_{tag}.json")
    if os.path.exists(lp):
        try:
            led = json.load(open(lp, encoding="utf-8"))
        except Exception:
            led = {}

    rets = [r["ret"] for r in sells if isinstance(r.get("ret"), (int, float))]
    pnls = [r["pnl"] for r in sells if isinstance(r.get("pnl"), (int, float))]
    total = sum(pnls) if pnls else 0.0
    wins = [x for x in rets if x > 0]
    losses = [x for x in rets if x <= 0]

    why_count = defaultdict(int)
    for r in sells:
        why_count[r.get("why", "?")] += 1

    grad_exits = [r for r in sells if "毕业" in str(r.get("why", ""))]
    timeout_exits = [r for r in sells if "超时" in str(r.get("why", ""))]

    L = []
    add = L.append
    add(f"# 纸面引擎日报 · {day}\n")
    add(f"> 策略：hold-to-graduation（进度≥55% 入场，不设止损止盈，毕业或超时离场）  ")
    add(f"> 生成时间：{datetime.now(TZ).strftime('%Y-%m-%d %H:%M:%S')} (UTC+8)  ")
    add(f"> 数据来源：真实 pump.fun 链上 tick（前视，不是回测）\n")

    add("## 一、当日概况\n")
    add("| 指标 | 数值 |")
    add("|---|---|")
    add(f"| 入场笔数 | {len(buys)} |")
    add(f"| 平仓笔数 | {len(sells)} |")
    add(f"| 胜 / 负 | {len(wins)} / {len(losses)} |")
    add(f"| 胜率 | {(len(wins) / len(rets) * 100 if rets else 0):.1f}% |")
    add(f"| 已实现盈亏 | {total:+.4f} SOL |")
    add(f"| 平均单笔收益 | {pct(statistics.mean(rets)) if rets else '-'} |")
    add(f"| 中位单笔收益 | {pct(statistics.median(rets)) if rets else '-'} |")
    add(f"| 最大盈利 | {pct(max(rets)) if rets else '-'} |")
    add(f"| 最大亏损 | {pct(min(rets)) if rets else '-'} |")
    add(f"| 毕业出场 / 超时出场 | {len(grad_exits)} / {len(timeout_exits)} |")
    if rets:
        add(f"| 命中毕业率 | {len(grad_exits) / len(rets) * 100:.1f}% |")
    add("")

    # 账本状态
    if led:
        add("## 二、账本当前状态\n")
        pos = led.get("pos", [])
        add(f"- 纸面余额：**{led.get('bal', 0):.4f} SOL**")
        add(f"- 累计已平：{len(led.get('done', []))} 笔（胜 {led.get('wins', 0)} / 负 {led.get('losses', 0)}）")
        add(f"- 当前持仓：{len(pos)} 个")
        if pos:
            add("")
            add("| 币 | 入场进度 | 成本 SOL | 持有分钟 |")
            add("|---|---|---|---|")
            for p in pos:
                mins = (datetime.now(TZ).timestamp() * 1000 - p.get("opened", 0)) / 60000
                add(f"| {p.get('sym') or p['mint'][:8]} | {p.get('entryProg', 0):.0f}% | {p.get('cost', 0):.4f} | {mins:.0f} |")
        add("")

    # 离场原因分布
    if why_count:
        add("## 三、离场原因分布\n")
        add("| 原因 | 笔数 |")
        add("|---|---|")
        for k, v in sorted(why_count.items(), key=lambda x: -x[1]):
            add(f"| {k} | {v} |")
        add("")

    # 按入场进度分档
    if sells:
        buy_map = {r["mint"]: r for r in buys}
        buckets = defaultdict(list)
        for r in sells:
            b = buy_map.get(r.get("mint"))
            if not b:
                continue
            p = b.get("entryProg", 0)
            key = "50~55%" if p < 55 else "55~60%" if p < 60 else "60~67%" if p < 67 else "≥67%"
            buckets[key].append(r.get("ret", 0))
        if buckets:
            add("## 四、按入场进度分档\n")
            add("| 入场进度 | 笔数 | 平均收益 | 胜率 |")
            add("|---|---|---|---|")
            for k in ("50~55%", "55~60%", "60~67%", "≥67%"):
                if k not in buckets:
                    continue
                v = buckets[k]
                wr = len([x for x in v if x > 0]) / len(v) * 100
                add(f"| {k} | {len(v)} | {pct(statistics.mean(v))} | {wr:.0f}% |")
            add("")

    # 逐笔明细
    if sells:
        add("## 五、逐笔明细\n")
        add("| 时间 | 币 | 入场% | 离场原因 | 收益率 | 盈亏 SOL | 持有分 |")
        add("|---|---|---|---|---|---|---|")
        buy_map = {r["mint"]: r for r in buys}
        for r in sells[-60:]:
            b = buy_map.get(r.get("mint"), {})
            ts = datetime.fromtimestamp(r.get("t", 0) / 1000, TZ).strftime("%H:%M:%S")
            add(f"| {ts} | {r.get('sym') or r.get('mint', '')[:8]} | {b.get('entryProg', 0):.0f}% | "
                f"{r.get('why', '')} | {pct(r.get('ret', 0))} | {r.get('pnl', 0):+.4f} | {r.get('holdMin', 0):.0f} |")
        add("")

    if not sells:
        add("## 说明\n")
        add("当日没有平仓记录。可能原因：① 入场门槛未触发（进度≥55% 的币本来就少）；② 持仓尚未毕业（需等待）。")
        add("")

    path = os.path.join(REPORTS, f"grad_{tag}_{day}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return path


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else None
    tg = sys.argv[2] if len(sys.argv) > 2 else 'confirm'
    p = build(d, tg)
    print("已生成", p)
    print(open(p, encoding="utf-8").read()[:1500])
