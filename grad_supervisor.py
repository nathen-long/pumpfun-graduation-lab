#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hold-to-graduation 纸面引擎守护（并行对照组版）
  python grad_supervisor.py            后台常驻：同时跑 confirm / fast 两组，各自独立账本
  python grad_supervisor.py --status   看两组状态
  python grad_supervisor.py --once 600 前台跑 600 秒自检（只跑 confirm 组）
设计：
  · 两组共用同一套行情与代码，只有「入场规则」不同，本金各 0.5 SOL → 干净的 A/B 对照
  · 单实例锁；子进程异常退出自动重启（连续快退指数退避）
  · 每天 00:00:10 归档两组流水 + 各出一份日报
"""
import os
import sys
import time
import json
import ctypes
import subprocess
import shutil
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
TRADER = os.path.join(ROOT, "trader")
LOGS = os.path.join(ROOT, "logs")
GRAD = os.path.join(ROOT, "data", "grad")
REPORTS = os.path.join(ROOT, "reports")
PIDF = os.path.join(ROOT, "grad_supervisor.pid")
TZ = timezone(timedelta(hours=8))
NODE = r"C:\Program Files\nodejs\node.exe"

COMMON = {
    "ENTRY_PCT": "50",
    "MAX_ABOVE": "20",
    "SIZE_SOL": "0.02",
    "MAX_POS": "20",
    "MAX_EXPOSURE": "0.5",
    "MAX_HOLD_H": "0.5",
}
GROUPS = [
    {"tag": "confirm", "desc": "守住确认制（跨过后60秒未跌破50%）",
     "env": {"RULE": "confirm", "CONFIRM_SEC": "60", "FAKE_DROP": "20", "MIN_AGE_SEC": "10"}},
    {"tag": "fast", "desc": "秒拉制（首笔成交到跨过50% ≤10秒）",
     "env": {"RULE": "fast", "FAST_RISE_SEC": "10", "MIN_AGE_SEC": "0"}},
]

for d in (LOGS, GRAD, REPORTS):
    os.makedirs(d, exist_ok=True)


def log(msg):
    line = f"[{datetime.now(TZ).strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    with open(os.path.join(LOGS, "grad_supervisor.log"), "a", encoding="utf-8") as f:
        f.write(line + "\n")


def alive(pid):
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def daykey():
    return datetime.now(TZ).strftime("%Y-%m-%d")


def secs_to_midnight():
    now = datetime.now(TZ)
    nxt = (now + timedelta(days=1)).replace(hour=0, minute=10, second=10, microsecond=0)
    return max(60, (nxt - now).total_seconds())


def start_group(g):
    env = dict(os.environ)
    env.update(COMMON)
    env.update(g["env"])
    env["RUN_TAG"] = g["tag"]
    out = open(os.path.join(LOGS, f"graduation_console_{g['tag']}.log"), "a", encoding="utf-8")
    kw = {"creationflags": 0x08000000 | 0x00000008} if os.name == "nt" else {}
    p = subprocess.Popen([NODE, "graduation.mjs"], cwd=TRADER, env=env,
                         stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, **kw)
    g["proc"] = p
    g["out"] = out
    log(f"启动【{g['tag']}】{g['desc']} PID={p.pid}")
    return p


def stop_group(g):
    p = g.get("proc")
    if not p:
        return
    try:
        p.terminate()
        p.wait(timeout=30)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
    if g.get("out"):
        try:
            g["out"].close()
        except Exception:
            pass
    g["proc"] = None


def archive_and_report(day):
    for g in GROUPS:
        tag = g["tag"]
        src = os.path.join(LOGS, f"graduation_trades_{tag}.jsonl")
        if not (os.path.exists(src) and os.path.getsize(src) > 0):
            continue
        dst_dir = os.path.join(GRAD, tag, day)
        os.makedirs(dst_dir, exist_ok=True)
        dst = os.path.join(dst_dir, "trades.jsonl")
        try:
            shutil.move(src, dst)
            n = sum(1 for _ in open(dst, encoding="utf-8", errors="ignore"))
            log(f"归档【{tag}】{day} 流水 {n} 条")
        except Exception as e:
            log(f"归档【{tag}】失败：{e}")
    try:
        sys.path.insert(0, ROOT)
        import grad_report
        for g in GROUPS:
            path = grad_report.build(day, g["tag"])
            log(f"日报【{g['tag']}】已生成 {path}")
    except Exception as e:
        log(f"生成日报失败：{e}")


def status():
    if not os.path.exists(PIDF):
        print("守护进程：未运行")
    else:
        pid = int(open(PIDF).read().strip() or 0)
        print(f"守护进程 PID {pid} {'运行中' if alive(pid) else '已退出'}")
    print()
    for g in GROUPS:
        tag = g["tag"]
        led = os.path.join(GRAD, f"ledger_{tag}.json")
        print(f"--[{tag}] {g['desc']}")
        if not os.path.exists(led):
            print("   (还没有账本)")
            continue
        try:
            L = json.load(open(led, encoding="utf-8"))
            done = L.get("done", [])
            tot = sum(done) if done else 0
            print(f"   余额 {L.get('bal', 0):.4f} SOL | 持仓 {len(L.get('pos', []))} | 已平 {len(done)} "
                  f"| 胜 {L.get('wins', 0)} 负 {L.get('losses', 0)} | 累计 {tot:+.4f} SOL")
            for p in L.get("pos", [])[:6]:
                mins = (time.time() * 1000 - p.get("opened", 0)) / 60000
                print(f"      - {str(p.get('sym') or p.get('mint', '')[:8]):<10} 入场 {p.get('entryProg', 0):.0f}% "
                      f"成本 {p.get('cost', 0):.3f} 持有 {mins:.0f} 分")
        except Exception as e:
            print("   账本读取失败：", e)
    print("\n最近日志：")
    lg = os.path.join(LOGS, "grad_supervisor.log")
    if os.path.exists(lg):
        for line in open(lg, encoding="utf-8").read().strip().split("\n")[-6:]:
            print("  " + line)


def main():
    args = sys.argv[1:]
    if "--status" in args:
        status()
        return
    if "--once" in args:
        i = args.index("--once")
        secs = int(args[i + 1]) if len(args) > i + 1 else 300
        g = GROUPS[0]
        start_group(g)
        try:
            g["proc"].wait(timeout=secs)
        except subprocess.TimeoutExpired:
            stop_group(g)
        log("自检结束")
        return

    if os.path.exists(PIDF):
        old = int(open(PIDF).read().strip() or 0)
        if old != os.getpid() and alive(old):
            log(f"已有守护进程 PID={old} 在运行，本次退出")
            return
    open(PIDF, "w").write(str(os.getpid()))

    log(f"纸面守护启动 PID={os.getpid()}，并行 {len(GROUPS)} 组：{[g['tag'] for g in GROUPS]}")
    while True:
        day = daykey()
        secs = secs_to_midnight()
        t0 = time.time()
        for g in GROUPS:
            start_group(g)
        fast_exits = {g["tag"]: 0 for g in GROUPS}
        while time.time() - t0 < secs:
            time.sleep(5)
            for g in GROUPS:
                p = g.get("proc")
                if p is None:
                    continue
                rc = p.poll()
                if rc is not None:
                    ran = time.time() - t0
                    fast_exits[g["tag"]] = fast_exits[g["tag"]] + 1 if ran < 60 else 0
                    wait = min(60, 5 * (2 ** min(fast_exits[g['tag']], 4)))
                    log(f"[{g['tag']}] 退出 rc={rc} 运行 {ran:.0f}s，{wait}s 后重启")
                    try:
                        g["out"].close()
                    except Exception:
                        pass
                    time.sleep(wait)
                    start_group(g)
        for g in GROUPS:
            stop_group(g)
        if daykey() != day:
            archive_and_report(day)
        else:
            log("到达日切点但日期未变，跳过归档")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("收到中断")
