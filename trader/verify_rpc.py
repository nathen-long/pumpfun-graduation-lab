#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RPC 独立复测：连通性 / 延迟 / 限流阈值 / 额度特征（Key 脱敏）"""
import json, os, time, urllib.request, urllib.error, statistics

ROOT = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))


def mask(u):
    if not u:
        return "(未配置)"
    if "api-key=" in u:
        h, _, k = u.partition("api-key=")
        k = k.split("&")[0]
        return h + "api-key=" + (k[:6] + "…" + k[-4:] if len(k) > 12 else "****" + f" (长度{len(k)})")
    return u


RPC = cfg.get("rpc", "")
WSS = cfg.get("wss", "")
print("=" * 64)
print("RPC :", mask(RPC))
print("WSS :", mask(WSS))
print("回退:", cfg.get("rpcFallback"))
print("=" * 64)

def call(method, params=None, timeout=15):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode()), (time.time() - t0) * 1000, None
    except urllib.error.HTTPError as e:
        return None, (time.time() - t0) * 1000, f"HTTP {e.code}"
    except Exception as e:
        return None, (time.time() - t0) * 1000, str(e)[:60]

# 1. 版本 + 延迟（5 次取中位数）
d, ms, err = call("getVersion")
if err:
    print(f"❌ 连不上: {err}")
    raise SystemExit(1)
print(f"✅ 节点版本 {d['result'].get('solana-core', '?')}   首次延迟 {ms:.0f}ms")

lat = []
for _ in range(5):
    d, ms, err = call("getSlot")
    if not err:
        lat.append(ms)
    time.sleep(0.12)
print(f"✅ getSlot 延迟: 中位 {statistics.median(lat):.0f}ms  最小 {min(lat):.0f}ms  最大 {max(lat):.0f}ms")

# 2. 余额
w = cfg.get("wallet")
d, ms, err = call("getBalance", [w])
if not err and "result" in d:
    print(f"✅ 钱包 {w[:6]}…{w[-4:]} = {d['result']['value']/1e9:.6f} SOL")

# 3. 限流阈值：连打 30 次不等待
ok = lim = other = 0
t0 = time.time()
for _ in range(30):
    d, ms, err = call("getSlot", timeout=10)
    if err:
        if "429" in err:
            lim += 1
        else:
            other += 1
    elif d and d.get("error", {}).get("code") == 429:
        lim += 1
    else:
        ok += 1
dt = time.time() - t0
print(f"{'✅' if lim == 0 else '⚠️ '} 连打 30 次: 成功 {ok}, 限流 {lim}, 其他错误 {other} | {30/dt:.0f} 次/秒")

# 4. 实测可持续速率：每秒 10 次，跑 3 秒，看是否被限
ok2 = lim2 = 0
for _ in range(3):
    for _ in range(10):
        d, ms, err = call("getSlot", timeout=8)
        if err and "429" in str(err): lim2 += 1
        elif not err: ok2 += 1
    time.sleep(1.0)
print(f"{'✅' if lim2 == 0 else '⚠️ '} 10 次/秒持续 3 秒: 成功 {ok2}, 限流 {lim2}")

# 5. 关键接口可用性（我们要用的）
print("\n关键接口:")
for m, p in [("getRecentPrioritizationFees", [["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]]),
             ("getHealth", []),
             ("getLatestBlockhash", [])]:
    d, ms, err = call(m, p, timeout=10)
    good = (not err) and d and ("result" in d) and not d.get("error")
    print(f"  {'✅' if good else '❌'} {m:34s} {ms:5.0f}ms")
    time.sleep(0.15)

# 6. 额度估算
print("\n" + "=" * 64)
print("额度估算（Helius 免费档 = 每月 100 万 credits）")
print("=" * 64)
print("  1 次 RPC 调用 ≈ 1 credit（getTransaction 这类重调用会更多）")
print("  采集器 24h 约 3~5 万次通知 → 按 1 次订阅 + 少量查询算，约 3~6 万 credits/天")
print("  graduation 引擎每仓 45 秒查 1 次 → 5 仓 = 约 1 万 credits/天")
print("  → 总额度大约能撑 15~25 天；跑满一个月需要升级或降低轮询频率")
