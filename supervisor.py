# -*- coding: utf-8 -*-
"""采集器常驻守护进程
- 每天 00:00（北京时间）自动「日切」：把 data/*.jsonl 归档到 data/YYYY-MM-DD/，并生成 reports/YYYY-MM-DD.md
- 采集中途崩溃会自动重启（同一天内），不会丢当天的数据（追加写）
- 所有日志写 logs/supervisor.log

用法：
  python supervisor.py              # 常驻（生产）
  python supervisor.py --once 120   # 只采 120 秒然后归档+出报告（自检用）
  python supervisor.py --status     # 看当前状态
"""
import json, os, subprocess, sys, time, shutil, signal
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
ARCH = DATA
LOGS = os.path.join(ROOT, "logs")
REPORTS = os.path.join(ROOT, "reports")
PIDF = os.path.join(ROOT, "supervisor.pid")
SUPLOG = os.path.join(LOGS, "supervisor.log")
for d in (DATA, LOGS, REPORTS): os.makedirs(d, exist_ok=True)

NODE = shutil.which("node") or "node"

import ctypes
def alive(pid):
    """跨进程存活检测：不依赖 tasklist 的输出编码"""
    if not pid or pid <= 0: return False
    if os.name != "nt":
        try: os.kill(pid, 0); return True
        except Exception: return False
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))   # QUERY_LIMITED_INFORMATION
    if not h: return False
    code = ctypes.c_ulong()
    ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return bool(ok) and code.value == 259                              # STILL_ACTIVE


def now(): return datetime.now(TZ)
def daykey(dt=None): return (dt or now()).strftime("%Y-%m-%d")
def log(msg):
    line = f"[{now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(SUPLOG, "a", encoding="utf-8") as f: f.write(line + "\n")
    except: pass

def secs_to_midnight():
    n = now()
    tom = (n + timedelta(days=1)).replace(hour=0, minute=0, second=10, microsecond=0)
    return max(30, int((tom - n).total_seconds()))

def archive(day):
    """把 data/*.jsonl 移到 data/<day>/；返回移动的文件数"""
    tgt = os.path.join(ARCH, day)
    files = [f for f in os.listdir(DATA) if f.endswith(".jsonl")]
    if not files: return 0
    os.makedirs(tgt, exist_ok=True)
    n = 0
    for f in files:
        src = os.path.join(DATA, f)
        if os.path.getsize(src) == 0:
            os.remove(src); continue
        dst = os.path.join(tgt, f)
        if os.path.exists(dst):                     # 同名已存在 → 追加
            with open(src, "rb") as fi, open(dst, "ab") as fo: shutil.copyfileobj(fi, fo)
            os.remove(src)
        else:
            shutil.move(src, dst)
        n += 1
    return n

def summarize(day):
    tgt = os.path.join(ARCH, day)
    if not os.path.isdir(tgt): return
    try:
        p = subprocess.run([sys.executable, os.path.join(ROOT, "summarize.py"), tgt],
                           capture_output=True, text=True, encoding="utf-8", errors="ignore", timeout=1800)
        tail = (p.stdout or "").strip().splitlines()[-3:]
        log(f"日报 {day} 完成：" + (" | ".join(tail) if tail else "无输出"))
        if p.returncode != 0: log("日报失败：" + (p.stderr or "")[-400:])
    except Exception as e:
        log(f"日报异常 {day}: {e}")

def run_collector(secs, day):
    """跑一次采集器，阻塞到它退出"""
    logf = open(os.path.join(LOGS, f"collector_{day}.log"), "a", encoding="utf-8")
    cmd = [NODE, os.path.join(ROOT, "collector2.mjs"), str(secs)]
    log(f"启动采集器 {secs}s → {os.path.basename(logf.name)}")
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = 0x08000000 | 0x00000008   # CREATE_NO_WINDOW | DETACHED_PROCESS
    p = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, **kw)
    return p, logf

def status():
    if not os.path.exists(PIDF):
        print("未运行（没有 supervisor.pid）"); return
    pid = int(open(PIDF).read().strip() or 0)
    up = alive(pid)
    files = {f: os.path.getsize(os.path.join(DATA, f)) for f in os.listdir(DATA) if f.endswith(".jsonl")}
    print(f"PID {pid} {'✅ 运行中' if up else '❌ 已退出'}")
    print(f"今日 {daykey()} · 实时文件 {files}")
    print(f"最近 5 行日志：")
    try:
        for l in open(SUPLOG, encoding="utf-8").read().strip().splitlines()[-5:]: print("  " + l)
    except: pass

def main():
    args = sys.argv[1:]
    if "--status" in args: status(); return
    once = None
    if "--once" in args:
        i = args.index("--once")
        once = int(args[i + 1]) if len(args) > i + 1 else 120

    if os.path.exists(PIDF):
        try:
            old = int(open(PIDF).read().strip() or 0)
            if old != os.getpid() and alive(old):
                log(f"已有守护进程在跑（PID {old}），本次退出"); return
        except Exception: pass
    open(PIDF, "w").write(str(os.getpid()))

    # 启动前先处理昨天残留的实时数据
    files = [f for f in os.listdir(DATA) if f.endswith(".jsonl") and os.path.getsize(os.path.join(DATA, f)) > 0]
    if files:
        try:
            first = json.loads(open(os.path.join(DATA, "trades.jsonl"), encoding="utf-8").readline())
            oldday = datetime.fromtimestamp(first["t"] / 1000, TZ).strftime("%Y-%m-%d")
            if oldday != daykey():
                n = archive(oldday); log(f"归档残留数据 {oldday}（{n} 个文件）"); summarize(oldday)
        except Exception as e:
            log(f"检查残留数据失败：{e}")

    if once:
        day = daykey()
        p, logf = run_collector(once, day)
        p.wait(); logf.close()
        # 一次性自检：归档到当天目录并出报告，然后还原成"实时"目录继续可用
        n = archive(day); log(f"自检归档 {day}：{n} 个文件")
        summarize(day)
        for f in os.listdir(os.path.join(ARCH, day)):
            shutil.move(os.path.join(ARCH, day, f), os.path.join(DATA, f))
        log("自检完成，数据已还原到 data/")
        return

    log(f"守护进程启动 PID={os.getpid()} · 日切点 00:00:10 (UTC+8)")
    while True:
        day = daykey()
        secs = secs_to_midnight()
        log(f"今日 {day}，本次采集 {secs}s（到 00:00:10 为止）")
        started = time.time()
        p, logf = run_collector(secs, day)
        try:
            p.wait()
        except KeyboardInterrupt:
            log("收到中断，停止采集器并归档")
            try: p.terminate()
            except: pass
            p.wait()
        logf.close()
        elapsed = time.time() - started
        if daykey() != day:
            n = archive(day); log(f"日切归档 {day}：{n} 个文件")
            summarize(day)
        else:
            log(f"采集器提前退出（运行 {elapsed:.0f}s / 预期 {secs}s），5 秒后重启（数据为追加写，不会丢）")
            time.sleep(5)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("守护进程退出")
