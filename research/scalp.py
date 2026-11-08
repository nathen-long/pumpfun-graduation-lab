# -*- coding: utf-8 -*-
"""最后一轮：高进度 + 紧止损 + 极短持仓，找有没有正期望的角落"""
import json, os, statistics as st
from array import array

ROOT = os.path.dirname(os.path.abspath(__file__))
DIRS = [os.path.join(ROOT, 'data'), os.path.join(ROOT, 'data', '2026-11-05'), os.path.join(ROOT, 'data', '2026-11-06')]
X0, K, RG, r = 30.0, 30.0 * 1.073e9, 85.0, 1 - 0.0125
price = lambda R: (X0 + R) ** 2 / K
prog = lambda R: max(0.0, min(300.0, R / RG * 100))
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
T = {}; wid = {}
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
        m = t['m']; b = T.get(m)
        if b is None: b = T[m] = {'t': array('q'), 'R': array('f'), 'sol': array('f'), 'sd': bytearray(), 'w': array('i')}
        w = t['w']
        if w not in wid: wid[w] = len(wid)
        b['t'].append(int(tv)); b['R'].append(float(rv)); b['sol'].append(float(t['sol']))
        b['sd'].append(1 if t['s'] == 'b' else 0); b['w'].append(wid[w])
print('币 ' + format(len(T), ',') + ' 个', flush=True)

FIXED = 2 * (0.0005 + 0.000005) + 0.00047
SIZE = 0.05

def simulate(b, i0, X):
    ts, R = b['t'], b['R']; n = len(ts)
    held = buy_tokens(R[i0], SIZE); cash = 0.0; j = i0; lastP = price(R[i0]); t0 = ts[i0]
    why = '截断'
    while True:
        k = j
        while k + 1 < n and ts[k + 1] <= ts[j] + X['tick']: k += 1
        if k == j:
            if j + 1 >= n: cash += sell_sol(R[j], held); break
            k = j + 1
        j = k; Rc = R[j]; tcur = ts[j]; pcur = price(Rc)
        if j >= n - 1: cash += sell_sol(Rc, held); why = '截断'; break
        if prog(Rc) >= X['exitProg']: cash += sell_sol(RG * X['exitProg'] / 100, held); why = '毕业前'; break
        val = sell_sol(Rc, held); pnl = val / SIZE - 1
        if lastP > 0 and (1 - pcur / lastP) >= X['rug']: cash += val; why = '砸盘'; break
        if pnl >= X['tp']: cash += val; why = '止盈'; break
        if pnl <= -X['stop']: cash += val; why = '止损'; break
        if (tcur - t0) / 1000 >= X['hold']: cash += val; why = '超时'; break
        lastP = pcur
    return (cash - FIXED) / SIZE - 1, why

def feat(b, i, back_ms):
    ts, sd, w = b['t'], b['sd'], b['w']
    lo = i
    while lo > 0 and ts[lo - 1] > ts[i] - back_ms: lo -= 1
    buyers = set(); nb = ns = 0
    for k in range(lo, i + 1):
        if sd[k]: nb += 1; buyers.add(w[k])
        else: ns += 1
    return len(buyers), nb, ns

def run(en, X):
    rows = []
    for m, b in T.items():
        n = len(b['t'])
        if n < 20: continue
        c = coins.get(m); tb = (c or {}).get('ts') or b['t'][0]
        for i in range(1, n):
            age = (b['t'][i] - tb) / 1000
            if age < en['minAge'] or age > en['maxAge']: continue
            pr = prog(b['R'][i])
            if pr < en['minProg'] or pr > en['maxProg']: continue
            uniq, nb, ns = feat(b, i, en['win'])
            if uniq < en['minBuyers']: continue
            rows.append(simulate(b, i, X)); break
    return rows

ENTS = [
    ('高进度70-95 买家>=20', dict(minAge=20, maxAge=1200, minProg=70, maxProg=95, minBuyers=20, win=60000)),
    ('高进度55-90 买家>=30', dict(minAge=20, maxAge=1200, minProg=55, maxProg=90, minBuyers=30, win=60000)),
    ('中高40-80 买家>=40', dict(minAge=20, maxAge=1200, minProg=40, maxProg=80, minBuyers=40, win=60000)),
]
best = []
for en_name, en in ENTS:
    print('')
    print('【' + en_name + '】')
    shown = 0
    for tp in (0.15, 0.25, 0.40):
        for stop in (0.08, 0.15, 0.25):
            for hold in (30, 60, 120):
                X = dict(tick=1000, tp=tp, stop=stop, hold=hold, exitProg=95, rug=0.40)
                rows = run(en, X)
                if not rows: continue
                v = sorted(x[0] for x in rows); mu = st.mean(v); wr = sum(1 for x in v if x > 0) / len(v)
                best.append((mu, en_name, 'tp' + str(int(tp * 100)) + ' stop' + str(int(stop * 100)) + ' hold' + str(hold) + 's', len(v), wr, st.median(v)))
                if mu > -0.05 and shown < 6:
                    print('  tp{:<3} stop{:<3} hold{:<4}s n={:<4} 均值 {:+.1f}% 胜率 {:.1f}% 中位 {:+.1f}%'.format(
                        int(tp * 100), int(stop * 100), hold, len(v), mu * 100, wr * 100, st.median(v) * 100))
                    shown += 1
best.sort(reverse=True)
print('')
print('=== 全部 ' + str(len(best)) + ' 个组合中最好的 8 个 ===')
for mu, en, xn, n, wr, md in best[:8]:
    print('  {:+.1f}%  {:<20} {:<26} n={} 胜率 {:.0f}% 中位 {:+.1f}%'.format(mu * 100, en, xn, n, wr * 100, md * 100))
print('')
print('正期望组合数：{} / {}'.format(sum(1 for b in best if b[0] > 0), len(best)))
