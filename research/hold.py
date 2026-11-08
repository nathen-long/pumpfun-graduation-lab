# -*- coding: utf-8 -*-
"""验证"中高进度买入、持有到毕业"的期望
- 入场：进度首次跨过 X%
- 出场：进度 >= 99.5%（毕业）→ 按毕业价卖出；否则按 45 分钟后 / 数据结束时的价卖出
- 不设止损、不设止盈（这就是条件毕业概率那张表对应的策略）
成本：1.25%/边（已含在曲线数学里）+ 优先费 + ATA 等固定成本
"""
import json, os, statistics as st
from array import array

ROOT = os.path.dirname(os.path.abspath(__file__))
DIRS = [os.path.join(ROOT, 'data'), os.path.join(ROOT, 'data', '2026-11-05'), os.path.join(ROOT, 'data', '2026-11-06')]
X0, K, RG, r = 30.0, 30.0 * 1.073e9, 85.0, 1 - 0.0125
price = lambda R: (X0 + R) ** 2 / K
prog = lambda R: R / RG * 100
def buy_tokens(R, d): return K / (X0 + R) - K / (X0 + R + d * r)
def sell_sol(R, h):
    if h <= 0 or R <= 0: return 0.0
    v = K / (X0 + R)
    return max(0.0, min(((X0 + R) - K / (v + h)) * r, R))

coins = {}
for d in DIRS:
    p = os.path.join(d, 'coins.jsonl')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8', errors='ignore'):
            try: c = json.loads(line); coins[c['mint']] = c
            except: pass
T = {}
for d in DIRS:
    p = os.path.join(d, 'trades.jsonl')
    if not os.path.exists(p): continue
    for line in open(p, encoding='utf-8', errors='ignore'):
        try: t = json.loads(line)
        except: continue
        if not (t.get('sol', 0) > 0): continue
        tv = t.get('t'); rv = t.get('rsol')
        if not isinstance(tv, (int, float)) or not (1.5e12 < tv < 3.0e12): continue
        if not isinstance(rv, (int, float)) or not (0 <= rv < 500): continue
        b = T.get(t['m'])
        if b is None: b = T[t['m']] = {'t': array('q'), 'R': array('f')}
        b['t'].append(int(tv)); b['R'].append(float(rv))
TEND = max((b['t'][-1] for b in T.values() if b['t']), default=0)
print('币 ' + format(len(T), ',') + ' 个 | 有创建事件 ' + format(len(coins), ','))
FULL = {m for m, c in coins.items() if c.get('ts') and c['ts'] < TEND - 150 * 60000}
print('观察完整（创建于数据末尾 150 分钟前）的币: ' + format(len(FULL), ','))

SIZE = 0.05
FIXED = 2 * (0.0005 + 0.000005) + 0.00047     # 优先费×2 + 基础费×2 + 一次性

def run(th, max_hold_min=45, require_born=True):
    rows = []
    for m, b in T.items():
        if require_born and m not in FULL: continue
        n = len(b['t'])
        if n < 5: continue
        R, ts = b['R'], b['t']
        i0 = None
        for i in range(n):
            if prog(R[i]) >= th: i0 = i; break
        if i0 is None: continue
        t0 = ts[i0]
        # 从入场点往后扫
        exitR = None; why = None; dur = 0
        peakR = R[i0]
        for j in range(i0 + 1, n):
            dur = (ts[j] - t0) / 1000
            peakR = max(peakR, R[j])
            # 毕业判据：曾达到 >=82 SOL（96.5% 进度）即视为走到毕业；
            # 不再用"归零=迁移"（会把砸盘误判成毕业）
            if peakR >= 82: exitR = RG * 0.985; why = '毕业'; break
            if dur >= max_hold_min * 60: exitR = R[j]; why = '超时'; break
        if exitR is None:
            exitR = R[-1]; why = '数据截断'
        tok = buy_tokens(R[i0], SIZE)
        got = sell_sol(exitR, tok)
        ret = (got - FIXED) / SIZE - 1
        # 观察是否足够（截断且不足 5 分钟的算看不清）
        rows.append(dict(ret=ret, why=why, dur=dur, prog=prog(R[i0]),
                         grad=(why == '毕业'), truncated=(why == '数据截断')))
    return rows

def rep(name, rows):
    if not rows: print(name + ' n=0'); return
    ok = [x for x in rows if not x['truncated']]
    v = sorted(x['ret'] for x in rows)
    vv = sorted(x['ret'] for x in ok) if ok else v
    g = sum(1 for x in rows if x['grad'])
    print('{:<26} n={:<5} 毕业率 {:5.1f}%  均值 {:>+7.1f}%  中位 {:>+7.1f}%  胜率 {:4.1f}%  最好 {:>+6.0f}%  最差 {:>+6.0f}%  截断 {:.0f}%'.format(
        name, len(rows), g / len(rows) * 100, st.mean(v) * 100, st.median(v) * 100,
        sum(1 for x in v if x > 0) / len(v) * 100, max(v) * 100, min(v) * 100,
        sum(1 for x in rows if x['truncated']) / len(rows) * 100))
    if ok and len(ok) < len(rows):
        print('{:<26}   （剔除截断后：n={} 均值 {:+.1f}% 中位 {:+.1f}%）'.format('', len(ok), st.mean(vv) * 100, st.median(vv) * 100))
    if v:
        pos = sum(1 for x in v if x > 0.10)
        print('{:<26}   收益>+10% 的占比 {:.1f}%  | 亏光(-95%以上) 占比 {:.1f}%'.format('', pos / len(v) * 100, sum(1 for x in v if x < -0.95) / len(v) * 100))

print('')
print('=' * 132)
print('策略：进度跨过 X% 买入 → 持有到毕业（或 45 分钟）→ 不设止损止盈 | 单笔 {:.2f} SOL'.format(SIZE))
print('=' * 132)
for th in (20, 30, 40, 50, 60, 70, 80, 90):
    rep('买在 {:>2}% 进度'.format(th), run(th))

print('')
print('--- 超长持有（4~8 小时）+ 只统计观察完整的老币 ---')
for th in (60, 70, 80):
    for hm in (240, 480):
        rep('买在 {}% + 最长 {} 小时'.format(th, hm // 60), run(th, max_hold_min=hm))

print('')
print('--- 只看"币龄可信"的样本（有创建事件）已在上面；这里加对照：不限创建事件 ---')
rep('买在 60%（全部币）', run(60, require_born=False))
