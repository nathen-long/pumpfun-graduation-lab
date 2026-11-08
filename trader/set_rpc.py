#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Helius / 任意 Solana RPC 一键配置 + 自检
用法：双击项目根目录的 设置RPC.bat，或 python trader/set_rpc.py
安全：输入不回显；API Key 只写入 trader/config.json，不打印、不写日志。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(ROOT, "config.json")


def mask(u: str) -> str:
    """脱敏显示：只保留域名和 api-key 前后各 4 位"""
    if not u:
        return "(空)"
    if "api-key=" in u:
        head, _, key = u.partition("api-key=")
        key = key.split("&")[0]
        return head + "api-key=" + (key[:4] + "…" + key[-4:] if len(key) > 10 else "****")
    return u


def ask(prompt: str) -> str:
    """不回显读取（终端下用 getpass；管道下退化为普通读取）"""
    sys.stdout.write(prompt)
    sys.stdout.flush()
    if sys.stdin.isatty():
        import getpass
        try:
            return getpass.getpass("").strip()
        except Exception:
            return sys.stdin.readline().strip()
    return sys.stdin.readline().strip()


def rpc_call(url: str, method: str, params=None, timeout=15):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    return data, (time.time() - t0) * 1000


def main():
    print("=" * 62)
    print("  Solana RPC 一键配置（Helius 或任意 RPC 都行）")
    print("=" * 62)
    print()
    print("请打开 https://dashboard.helius.dev → 左侧 RPC → 点 URL 右边的眼睛图标显示完整地址")
    print("  ① RPC URL    以 https:// 开头，形如 https://mainnet.helius-rpc.com/?api-key=xxxx")
    print("  ② WebSocket  以 wss://   开头，形如 wss://mainnet.helius-rpc.com/?api-key=xxxx")
    print()
    print("提示：Windows 命令行里粘贴 = 鼠标右键。输入内容不会显示出来（正常现象）。")
    print()

    https_url = ask("① 粘贴 RPC URL      : ").strip().strip('"').strip("'")
    if not https_url:
        print("\n❌ 没收到地址，退出。")
        return 1
    if not https_url.startswith("http"):
        print("\n❌ 这不像一个 URL（要以 https:// 开头），退出。")
        return 1
    wss_url = ask("② 粘贴 WebSocket URL: ").strip().strip('"').strip("'")
    if wss_url and not wss_url.startswith("ws"):
        print("\n⚠️  WebSocket 地址格式不对，已忽略（后面可以再配）。")
        wss_url = ""

    print("\n" + "-" * 62)
    print("正在自检……")
    ok = True

    # 1) 连通性 + 延迟
    try:
        d, ms = rpc_call(https_url, "getSlot")
        if "result" in d:
            print(f"  ✅ 连通   getSlot={d['result']}  延迟 {ms:.0f}ms")
        elif "error" in d and d["error"].get("code") == 401:
            print(f"  ❌ API Key 无效（401）。请确认复制完整，包含 ?api-key= 后面那一串")
            ok = False
        else:
            print(f"  ⚠️  返回异常: {str(d)[:120]}")
            ok = False
    except urllib.error.HTTPError as e:
        print(f"  ❌ HTTP {e.code}（401=Key 错，403=被限制，429=超额度）")
        ok = False
    except Exception as e:
        print(f"  ❌ 连不上: {str(e)[:100]}")
        ok = False

    if ok:
        # 2) 读余额（顺带验证 getBalance 通）
        try:
            cfg = json.load(open(CFG_PATH, encoding="utf-8")) if os.path.exists(CFG_PATH) else {}
            wallet = cfg.get("wallet")
            if wallet:
                d, ms = rpc_call(https_url, "getBalance", [wallet])
                if "result" in d:
                    print(f"  ✅ 余额   钱包 {wallet[:8]}… = {d['result']['value'] / 1e9:.6f} SOL  ({ms:.0f}ms)")
        except Exception as e:
            print(f"  ⚠️  余额查询失败: {str(e)[:80]}")

        # 3) 测速率：连打 20 次，看会不会被限流（免费档 10 req/s）
        got429 = 0
        t0 = time.time()
        for _ in range(20):
            try:
                d, _ = rpc_call(https_url, "getSlot", timeout=8)
                if "error" in d and d["error"].get("code") == 429:
                    got429 += 1
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    got429 += 1
            except Exception:
                got429 += 1
        dt = time.time() - t0
        rps = 20 / dt if dt > 0 else 0
        if got429 == 0:
            print(f"  ✅ 速率   连打 20 次全部成功（{rps:.0f} 次/秒，未被限流）")
        else:
            print(f"  ⚠️  速率   20 次里 {got429} 次被限流（约 {rps:.0f} 次/秒）→ 说明确实有配额上限")

    # 4) 写入配置
    cfg = {}
    if os.path.exists(CFG_PATH):
        try:
            cfg = json.load(open(CFG_PATH, encoding="utf-8"))
        except Exception:
            cfg = {}
    cfg["rpc"] = https_url
    if wss_url:
        cfg["wss"] = wss_url
    # 公共节点降级为备用
    cfg.setdefault("rpcFallback", ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"])
    cfg.setdefault("wssFallback", ["wss://solana-rpc.publicnode.com"])
    with open(CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

    print("-" * 62)
    print("已写入:", CFG_PATH)
    print("  RPC :", mask(https_url))
    if wss_url:
        print("  WSS :", mask(wss_url))
    print()
    if ok:
        print("✅ 配置成功。可以关掉这个窗口了，然后去聊天里告诉我一声。")
    else:
        print("⚠️  已保存，但自检没通过，去聊天里把上面红色的错误告诉我。")
    return 0 if ok else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消。")
        sys.exit(1)
