# -*- coding: utf-8 -*-
"""决定性测试：条件毕业概率 vs 打平线
论文 (arXiv:2602.14860) 给了买持到毕业的打平条件：P(毕业 | 当前 vSol) > (vSol/115)^2
我用真实采集数据把左端测出来，和右端比较。
只统计"观察窗口足够长"的币（跨过阈值后还有 ≥5 分钟数据，或已确认毕业），避免把"没看到毕业"误判成"没毕业"。
"""
import json, os
from array import array

ROOT = os.path.dirname(os.path.abspath(__file__))
DIRS = [os.path.join(ROOT, 'data'), os.path.join(ROOT, 'data', '2026-11-05'), os.path.join(ROOT, 'data', '2026-11-06')]
RG = 85.0
prog = lambda R: R / RG * 100

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

print('币 ' + format(len(T), ',') + ' 个，其中有创建事件 ' + format(len(coins), ','))

TH = [2, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 95]
stat = {th: [0, 0] for th in TH}     # [reached, graduated]
obs = 0
for m, b in T.items():
    c = coins.get(m)
    if not c: continue                       # 只要币龄可信的
    n = len(b['t'])
    if n < 5: continue
    R = b['R']; ts = b['t']
    mx = max(R)
    last_t = ts[-1]
    # 找首次跨过每个阈值的时刻
    first = {}
    for i in range(n):
        pr = prog(R[i])
        for th in TH:
            if th not in first and pr >= th: first[th] = ts[i]
    # 毕业判据：曾达到 >=82 SOL（96.5% 进度）
    grad = mx >= 82.0
    for th in TH:
        if th not in first: continue
        # 观察窗口：跨过阈值后还看了多久
        window_ok = (last_t - first[th]) >= 300000 or grad
        if not window_ok: continue
        stat[th][0] += 1
        if grad: stat[th][1] += 1
        obs += 1

print('')
print('进度   到达币数   其中毕业   实测P(毕业)   打平线(vSol/115)^2   差距')
print('-' * 78)
for th in TH:
    n, g = stat[th]
    if n == 0:
        print('{:>4}%      0'.format(th)); continue
    p = g / n
    R = RG * th / 100
    vSol = 30 + R
    be = (vSol / 115.0) ** 2
    flag = '✅ 有正期望' if p > be else '❌ 负期望'
    print('{:>4}%   {:>7}   {:>7}   {:>9.2f}%   {:>15.2f}%   {:>+8.2f}pp  {}'.format(
        th, n, g, p * 100, be * 100, (p - be) * 100, flag))

print('')
print('说明：打平线来自"买入并持有到毕业、忽略手续费"的近似；加上 1.25%×2 与固定成本后，')
print('      实际要求比这一列还要高约 3~6 个百分点。')
