/* FMZ JavaScript：Pump.fun 打金狗 v3.3（v3.2 + 审计修复）
 * v3.3 修复清单（详见同目录 AUDIT.md）：
 *  P0-1 psCycleMs 未扣 psFlowMs → 开仓后自锁停买（现在扣除链上解析耗时）
 *  P0-2 成本模型补 ATA 租金 0.00204 SOL + 支持卖后回收；单笔 0.05→0.20 SOL
 *  P0-3 影子评估把毕业/迁移样本记 null 并剔除 → 幸存者偏差方向反了；改为按出场规则算收益
 *  P0-4 评分满分线按真实分布重标（goodSlope 3→10, goodNetSol 3→20, goodBuyers 10→40, minScore 60→80）
 *  P1-1 新增资金同源聚类（对抗同源钱包对倒刷分）+ 成交时间聚集度 + 只买不卖占比
 *  P1-2 抢筹检测 slot 窗口 +1→+12，翻不到创建 slot 时标记 unknown 而不是静默通过
 *  P1-3 持仓占比分母改为流通量（曲线期只流通 24%~78%，用总量会放水 1.5~4 倍）
 *  P1-4 创建者发币次数/黑名单持久化（原来只在内存，重启即失忆）
 *  P1-5 接力统计窗口不再被截断缩短（原版热门币窗口会缩到 5 秒）
 *  P1-6 毕业后卖出连续失败 → 移入 orphan 名单，不再永久占用 pMaxPos 名额
 *  P1-7 pump.sell 一律传数值，不再传字符串 "all"
 *  P1-8 psLastNew 持久化，重启不再重放 30 分钟历史
 *  P1-9 优先费上限 0.0005→0.0015（实测竞争槽位 p90）
 *───────────────────────────────────────────────────────────
 * v3.0：链上成交改按 pump TradeEvent 解析（不再认错代付钱包）、统计窗口固定、持仓按钱包合并、开盘抢筹钱包识别；
 *       入场由十几条硬门槛改为打分制 + 少量一票否决；新增影子评估（不下单记录候选币之后 3/10/30 分钟收益）；
 *       模拟扣优先费并延迟重报价；离场增加“进度回落”；优先费可按网络动态定价。
 * 交易所对象：exchanges[0] 为 Jupiter（Solana），交易对任意（如 SOL_USDC）。
 * 接口：IO("pump.new") 发现新币、IO("pump.info") 曲线进度/市值、IO("pump.quote") 本地报价、
 *       IO("pump.buy"/"pump.sell") 下单、IO("pump.holdings") 对账。
 * 思路参考 pump-fun-bot（监听新币→过滤→等待→买入→延时卖出），补充观察期动量确认、往返成本检查、
 *   分批止盈、移动止损、砸盘检测、创建者自动拉黑，以及账户级风控（仓位/敞口/日亏/连亏冷却/回撤停机/故障熔断）。
 * 默认“模拟”：只用 pump.quote 记账，不发交易。实盘须将“启用实盘交易”设为 1，并使用独立存档名称。
 * 风险：新币绝大多数归零，开发者/捆绑钱包砸盘很常见；只用输得起的极小金额。
 */
var PS_VERSION = 2;   // v3.0 存档结构兼容，沿用 2
var psCfg = null;
var psState = null;
var psReconcileBlock = "";
var psPreflightBlock = "";
var psEntryBufferSol = 0.005; // 新 ATA 租金及交易费预留
var psWatch = {};        // mint -> 观察中的新币
var psCreators = {};     // creator -> 本次运行见到的发币次数
var psSymbols = {};      // 小写 symbol -> 本次运行见到的次数（同名仿盘）
var psLastNew = 0;
var psErrStreak = 0;     // 连续 IO 失败次数
var psCycleMs = 0;       // 上一轮耗时
var psFunnel = {found: 0, filtered: 0, observed: 0, rejected: 0, bought: 0};
var psStart = Date.now();

// 策略参数是全局变量；直接粘贴代码未配置参数时用默认值
function psParam(name) { try { return eval(name); } catch (e) { return undefined; } }
function psNum(name, def) { var v = psParam(name); return v === undefined || v === "" ? def : Number(v); }
function psStr(name, def) { var v = psParam(name); return v === undefined ? def : String(v); }
function psList(s) { return String(s || "").split(/[,，\s]+/).map(function(x) { return x.trim(); }).filter(function(x) { return x; }); }
function psR(x, n) { return x === null || x === undefined || !isFinite(x) ? x : Number(Number(x).toFixed(n === undefined ? 6 : n)); }
function psShort(m) { return m == null ? "" : String(m); } // 地址完整显示
function psDay(t) { return _D((t || Date.now()) + 8 * 3600000).slice(0, 10); }   // 北京时间日期
function psDayTs(day) { return new Date(day + "T00:00:00+08:00").getTime(); }

function psCfgLoad() {
    var c = {
        mode: psNum("pLiveTrading", 0),              // 0 模拟 1 实盘，唯一实盘开关
        interval: psNum("pInterval", 2),
        namespace: psStr("pNamespace", "test"),
        // 资金与仓位
        capital: psNum("pCapital", 10),                 // 分配给本策略的 SOL（回撤、仓位按它算）
        buySol: psNum("pBuySol", 0.2),                   // 单笔买入上限
        minBuySol: psNum("pMinBuySol", 0.05),           // 算出的仓位低于此值就不买
        posPct: psNum("pPosPct", 5),                     // 单笔不超过当前权益的 %
        maxPos: psNum("pMaxPos", 5),
        maxExposure: psNum("pMaxExposure", 1.0),       // 未平仓成本合计上限 SOL
        reserveSol: psNum("pReserveSol", 3),
        // 账户风控
        maxBuysHour: psNum("pMaxBuysHour", 24),
        dailyLossSol: psNum("pDailyLossSol", 0.6),
        lossStreak: psNum("pLossStreak", 4),             // 连亏次数达到后冷却
        coolMin: psNum("pCoolMin", 120),
        maxDrawdown: psNum("pMaxDrawdown", 30),          // 权益自高点回撤 % → 停机，需手动解除
        maxErr: psNum("pMaxErr", 10),                     // 连续接口失败次数 → 暂停买入
        errPauseMin: psNum("pErrPauseMin", 10),
        maxLatency: psNum("pMaxLatency", 45),            // 上一轮耗时超过秒数，本轮不买（数据过旧）
        // 过滤
        devMin: psNum("pDevMin", 0),
        devMax: psNum("pDevMax", 1),
        creatorMax: psNum("pCreatorMax", 1),
        keywords: psList(psStr("pKeywords", "")).map(function(x) { return x.toLowerCase(); }),
        blacklist: psList(psStr("pBlacklist", "test,rug,scam")).map(function(x) { return x.toLowerCase(); }),
        creatorWhite: psList(psStr("pCreatorWhite", "")),
        creatorBlack: psList(psStr("pCreatorBlack", "")),
        // 观察期
        // v2.2：不再抢前两分钟，只买活过开盘、仍有人接力的币；价格条件不达标只等待，不拉黑
        observeSec: psNum("pObserveSec", 20),            // 进入观察池后至少观察多久
        minAgeSec: psNum("pMinAgeSec", 45),             // 币龄满此秒数才考虑买入
        maxAgeSec: psNum("pMaxAgeSec", 1800),            // 超过仍未买入就放弃
        infoSec: psNum("pInfoSec", 15),                  // 每个观察币多久查一次行情
        fastInfoSec: psNum("pFastInfoSec", 5),           // 进度接近入场下限（差 3 个百分点内）后的查询间隔
        deadSec: psNum("pDeadSec", 180),                 // 币龄达到此值时……
        deadProgress: psNum("pDeadProgress", 2),         // ……进度仍低于此 % 视为无人问津，清出观察池
        minProgress: psNum("pMinProgress", 10),
        maxProgress: psNum("pMaxProgress", 60),
        minRise: psNum("pMinRise", 0),                   // 近期涨幅下限 %（近期 = 观察池里最近约 40 次采样）；0 不限
        maxRise: psNum("pMaxRise", 100),                 // 近期涨幅上限 %，涨太急多为拉高出货；0 不限
        maxPullback: psNum("pMaxPullback", 15),          // 现价距近期最高价回落上限 %，已掉头先等
        devDupMax: psNum("pDevDupMax", 3),               // 10 分钟内同一开发者首买金额出现次数 ≥ 此值，视为批量发币工具；0 关闭
        maxImpact: psNum("pMaxImpact", 8),
        maxRoundTrip: psNum("pMaxRoundTrip", 8),         // 买入后立刻卖出的损失 %（手续费+双向冲击+两笔优先费）
        // 接力指标（直接查 Solana 节点，建议配置付费节点）
        flowOn: psNum("pFlowOn", 1),                     // 1 启用 0 关闭
        flowTx: psNum("pFlowTx", 20),                    // 每次最多解析的成交笔数
        flowWin: psNum("pFlowWin", 90),                  // 统计窗口（秒）
        minBuyers: psNum("pMinBuyers", 8),               // 窗口内独立买家下限（兜底；主要看评分）
        minScore: psNum("pMinScore", 62),                // 接力评分达到此分才买（0~100）
        goodSlope: psNum("pGoodSlope", 5),               // 进度斜率达到此值（百分点/分钟）得满分
        goodNetSol: psNum("pGoodNetSol", 3),             // 窗口净流入达到此 SOL 得满分
        goodBuyers: psNum("pGoodBuyers", 10),            // 独立买家达到此数得满分
        bigSell: psNum("pBigSell", 0.3),                 // 大单卖出阈值 SOL
        absorbSec: psNum("pAbsorbSec", 20),
        minAbsorb: psNum("pMinAbsorb", 0.8),             // 大单卖出后 absorbSec 秒内买入 SOL ÷ 卖出 SOL 下限（否决）
        maxTop1: psNum("pMaxTop1", 18),                   // 单一钱包持仓占比上限 %（否决）
        maxSniper: psNum("pMaxSniper", 25),              // 开盘前两个 slot 买家当前合计持仓上限 %（否决）
        shadowOn: psNum("pShadowOn", 1),                 // 影子评估：1 启用
        flowHoldSec: psNum("pFlowHoldSec", 6),           // 持仓期间多久查一次成交
        dumpSol: psNum("pDumpSol", 1),                   // 持仓期间 10 秒内卖出合计 ≥ 此值且买入不足 30% → 离场
        // 交易
        slippage: psNum("pSlippage", 0.05),
        priorityFee: psNum("pPriorityFee", 0.0015),      // 优先费上限（动态关闭时为固定值）
        dynFee: psNum("pDynFee", 1),                     // 1 按 pump 程序近期优先费动态定价
        minPriorityFee: psNum("pMinPriorityFee", 0.0003),
        feeCu: psNum("pFeeCu", 150000),                  // 估算计算单元
        paperDelay: psNum("pPaperDelay", 1500),          // 模拟：下单前等待毫秒再重新报价，近似真实成交延迟
        // 退出
        tp1: psNum("pTp1", 40),
        tp1Pct: psNum("pTp1Pct", 50),
        trail: psNum("pTrail", 25),
        stopLoss: psNum("pStopLoss", 25),
        staleSec: psNum("pStaleSec", 180),               // 持有这么久仍未达到 staleGain 就离场（不等满超时）
        staleGain: psNum("pStaleGain", 5),
        beAfter: psNum("pBeAfter", 30),                  // 浮盈曾达此值后，跌回成本即保本离场
        rugDrop: psNum("pRugDrop", 40),                  // 单轮可卖价值骤降 % → 紧急卖出并拉黑创建者
        maxHoldSec: psNum("pMaxHoldSec", 420),
        exitProgress: psNum("pExitProgress", 95),
        progDrop: psNum("pProgDrop", 8),
        // v3.3 新增
        ataReclaim: psNum("pAtaReclaim", 1),           // 卖出后是否关闭代币账户回收租金：1 尝试回收（不计入成本）0 不回收（计入成本）
        ataCost: psNum("pAtaCost", 0.00204),           // 每笔持仓的代币账户租金 SOL（不回收时计入往返成本）
        maxTop10: psNum("pMaxTop10", 55),              // 前十大持仓占**流通量**上限 %（否决）
        sniperSlots: psNum("pSniperSlots", 12),
        minSlope: psNum("pMinSlope", 1.5),             // 硬闸门：进度斜率低于此值（百分点/分钟）不买 —— 不接阴跌的刀        // 抢筹检测：创建 slot 之后多少个 slot 内的买家计入
        sniperUnknownVeto: psNum("pSniperUnknownVeto", 0), // 翻不到创建 slot 时是否否决（1 保守否决）
        clusterOn: psNum("pClusterOn", 1),             // 资金同源聚类（对抗同源钱包对倒刷分）
        clusterN: psNum("pClusterN", 8),               // 每次最多解析几个持仓最大的钱包
        clusterBudget: psNum("pClusterBudget", 2),     // 每轮最多新增几次 RPC 解析（有 7 天缓存）
        maxCluster: psNum("pMaxCluster", 30),          // 同一出资方的钱包合计占流通量上限 %（否决）
        burstVeto: psNum("pBurstVeto", 0.85),          // 250ms 内连续买入占比 ≥ 此值视为对倒/打包
        neverSoldVeto: psNum("pNeverSoldVeto", 0.85),  // 只买不卖的钱包占比 ≥ 此值视为捆绑建仓
        creatorDays: psNum("pCreatorDays", 7)                  // 曲线进度自持仓期最高点回落百分点 → 离场；0 关闭
    };
    if (c.mode !== 0 && c.mode !== 1) throw new Error("运行模式只能为模拟(0)或实盘(1)");
    if (c.mode === 1 && c.namespace === "test") throw new Error("实盘请先设置独立的存档名称，避免误用测试配置");
    var positive = ["interval","capital","buySol","minBuySol","posPct","maxPos","maxExposure","reserveSol","dailyLossSol","lossStreak","coolMin","maxDrawdown","maxBuysHour","maxErr","errPauseMin","maxLatency","maxAgeSec","flowTx","flowWin","priorityFee","feeCu","maxHoldSec","ataCost","goodSlope","goodNetSol","goodBuyers","maxCluster","clusterN"];
    positive.forEach(function(k) { if (!isFinite(c[k]) || c[k] <= 0) throw new Error("参数 " + k + " 必须为有限正数"); });
    if (!(c.buySol > 0 && c.buySol <= 1)) throw new Error("单笔买入上限须在 (0, 1] SOL");
    if (!(c.capital > 0)) throw new Error("策略资金须大于 0");
    if (!(c.slippage >= 0 && c.slippage < 1)) throw new Error("滑点须在 [0, 1)");
    if (!(c.stopLoss > 0 && c.stopLoss < 100)) throw new Error("止损须在 (0, 100)");
    if (!(c.maxAgeSec > c.minAgeSec)) throw new Error("币龄上限(" + c.maxAgeSec + "s)须大于最早入场币龄(" + c.minAgeSec + "s)，否则永远不会买入；旧机器人请把参数改成 v2.2 默认值");
    if (!(c.maxProgress > c.minProgress)) throw new Error("曲线进度上限须大于下限");
    if (!(c.minBuySol <= c.buySol && c.buySol <= c.maxExposure && c.posPct <= 100)) throw new Error("仓位参数冲突：最小单笔 ≤ 单笔上限 ≤ 总敞口，权益比例 ≤100%");
    if (!(c.tp1 > 0 && c.tp1Pct > 0 && c.tp1Pct < 100 && c.trail > 0 && c.trail < 100)) throw new Error("止盈与移动止损参数无效");
    if (!(c.exitProgress > c.maxProgress && c.exitProgress <= 100 && c.rugDrop > 0 && c.rugDrop <= 100)) throw new Error("毕业离场进度或砸盘跌幅参数无效");
    if (!(c.minPriorityFee >= 0 && c.minPriorityFee <= c.priorityFee && c.maxRoundTrip >= 0 && c.maxImpact >= 0)) throw new Error("费用或冲击参数无效");
    return c;
}

function psIO() {
    var r = null;
    var soft = arguments[0] === "pump.quote";   // 报价失败多为单币问题（储备不足/已毕业），不算接口故障
    try { r = exchange.IO.apply(exchange, Array.prototype.slice.call(arguments)); }
    catch (e) { Log("IO", arguments[0], psShort(arguments[1]), "异常:", e.message || e); }
    if (r === null || r === undefined) {
        if (soft) return null;
        psErrStreak++;
        var rk = psState.risk;
        if (psErrStreak >= psCfg.maxErr && Date.now() > rk.errUntil) {
            rk.errUntil = Date.now() + psCfg.errPauseMin * 60000;
            psEvent("warning", "接口连续失败 " + psErrStreak + " 次，暂停买入 " + psCfg.errPauseMin + " 分钟");
        }
        return null;
    }
    psErrStreak = 0;
    return r;
}

/* ---------- 状态 ---------- */
function psStateKey() { return "pumpSniper_" + psCfg.namespace + "_" + (psCfg.mode === 1 ? "live" : "paper"); }
function psLoad() {
    var s = _G(psStateKey());
    if (!s || s.v !== PS_VERSION) s = {
        v: PS_VERSION, pos: {}, done: {}, buys: [], day: psDay(), dayPnl: 0, totalPnl: 0, wins: 0, losses: 0,
        trades: [], closed: [], equity: [], daily: {}, events: [],
        pendingIntent: null, lastNew: 0, orphans: {},
        risk: {halted: false, haltReason: "", coolUntil: 0, errUntil: 0, streak: 0, peak: 0, paused: false, banned: {}, reconcileRequired: false, reconcileReason: "", pendingMint: "", pendingSide: ""}
    };
    psState = s;
    if (!s.risk) s.risk = {halted: false, haltReason: "", coolUntil: 0, errUntil: 0, streak: 0, peak: 0, paused: false, banned: {}};
    if (s.pendingIntent === undefined) s.pendingIntent = null;
    if (s.risk.reconcileRequired === undefined) s.risk.reconcileRequired = false;
    if (s.risk.reconcileReason === undefined) s.risk.reconcileReason = "";
    if (s.risk.pendingMint === undefined) s.risk.pendingMint = "";
    if (s.risk.pendingSide === undefined) s.risk.pendingSide = "";
    if (s.orphans === undefined) s.orphans = {};
    if (Number(s.lastNew) > 0) psLastNew = Number(s.lastNew);   // v3.3 P1-8：重启不重放 30 分钟历史
    if (!s.risk.peak) s.risk.peak = psEquity();
}
function psSave() { _G(psStateKey(), psState); }
function psEquity() { return psCfg.capital + psState.totalPnl; }
function psExposure() { var e = 0; for (var m in psState.pos) e += psState.pos[m].costLeft; return e; }
function psEvent(level, text) {
    psState.events.unshift({time: Date.now(), level: level, text: text});
    if (psState.events.length > 50) psState.events.length = 50;
    Log(text, level === "error" ? "#ff0000" : level === "warning" ? "#ff8800" : "");
}
function psRecord(t) { psState.trades.unshift(t); if (psState.trades.length > 200) psState.trades.length = 200; }

/* ---------- 详细日志（方便复盘和调参） ---------- */
var psFilterStat = {};   // 静态过滤原因 -> 次数，定期汇总一次，避免刷屏
var psFilterLast = Date.now();
var psDevAmts = {};      // 开发者首买金额（3 位小数）-> 出现时间列表，用来识别批量发币工具
function psDevKey(dev) { return Number(dev) > 0 ? Number(dev).toFixed(3) : ""; }
function psDevDup(key, now) {
    if (!key || !(psCfg.devDupMax > 0)) return false;
    var arr = (psDevAmts[key] || []).filter(function(t) { return t > now - 600000; });
    psDevAmts[key] = arr;
    return arr.length >= psCfg.devDupMax;
}
function psSec(ms) { return Math.round(ms / 1000) + "s"; }
function psWatchCtx(w, now) {
    var top = w.prices && w.prices.length ? Math.max.apply(null, w.prices) : 0;
    return "进度" + psR(w.progress, 1) + "% 涨幅" + psR(w.rise, 1) + "% 回落" + (top > 0 ? psR((1 - w.price / top) * 100, 1) : 0) + "%" +
        " 市值" + psR(w.mcap, 1) + "SOL 观察" + psSec(now - w.seen) + " 币龄" + psSec(now - w.created) + " 开发者首买" + psR(w.dev, 3);
}
function psPosCtx(p, now) {
    return "持有" + psSec(now - p.opened) + " 盈亏" + psR(p.pnlPct, 1) + "% 最高浮盈" + psR(Math.max(p.maxPnl || 0, p.pnlPct || 0), 1) + "% 进度" + psR(p.progress, 1) + "%";
}
/* ---------- v3.3 新增：创建者历史持久化（原版只在内存，重启后 pCreatorMax 形同虚设） ---------- */
var psCreatorDirty = 0, psCreatorFlushAt = 0;
function psCreatorKey() { return "pumpCreators_" + psCfg.namespace; }
function psCreatorLoad() {
    var c = _G(psCreatorKey());
    if (!c || typeof c !== "object") return;
    var cut = Date.now() - psCfg.creatorDays * 86400000, n = 0;
    for (var k in c) if (c[k] && c[k].t > cut) { psCreators[k] = Number(c[k].n) || 0; n++; }
    if (n) Log("📂 已恢复 " + n + " 个创建者的历史发币计数（" + psCfg.creatorDays + " 天）", "#999999");
}
function psCreatorBump(addr) {
    if (!addr) return;
    psCreators[addr] = (psCreators[addr] || 0) + 1;
    var c = _G(psCreatorKey()) || {};
    var e = c[addr] || {n: 0, t: 0};
    e.n++; e.t = Date.now(); c[addr] = e;
    _G(psCreatorKey(), c);
    psCreatorDirty = 0;
}

function psFilterSummary() {
    if (Date.now() - psFilterLast < 600000) return;
    var keys = Object.keys(psFilterStat).sort(function(a, b) { return psFilterStat[b] - psFilterStat[a]; });
    if (keys.length) Log("📊 近10分钟静态过滤：" + keys.map(function(k) { return k + " " + psFilterStat[k]; }).join("，"), "#999999");
    psFilterStat = {}; psFilterLast = Date.now();
}

/* ---------- 发现与过滤 ---------- */
function psFilter(c) {
    if (c.quote !== "SOL") return "非SOL报价";
    if (c.mayhem) return "mayhem币";
    var text = (String(c.name || "") + " " + String(c.symbol || "")).toLowerCase();
    for (var i = 0; i < psCfg.blacklist.length; i++) if (text.indexOf(psCfg.blacklist[i]) >= 0) return "名称黑名单";
    if (psCfg.keywords.length && !psCfg.keywords.some(function(k) { return text.indexOf(k) >= 0; })) return "不含关键词";
    var creator = String(c.creator || c.user || "");
    if (psCfg.creatorWhite.length && psCfg.creatorWhite.indexOf(creator) < 0) return "非白名单创建者";
    if (psCfg.creatorBlack.indexOf(creator) >= 0 || psState.risk.banned[creator]) return "创建者已拉黑";
    if (psCreators[creator] > psCfg.creatorMax) return "创建者批量发币";
    if (psSymbols[String(c.symbol || "").toLowerCase()] > 1) return "同名仿盘";
    var dev = c.devBuy && c.devBuy.quoteAmount !== null ? Number(c.devBuy.quoteAmount) : 0;
    if (psDevDup(psDevKey(dev), Date.now())) return "批量发币(首买" + psDevKey(dev) + ")";
    if (dev < psCfg.devMin) return "开发者首买过小";
    if (psCfg.devMax > 0 && dev > psCfg.devMax) return "开发者首买过大";
    if (!c.uri) return "无元数据";
    return "";
}

function psDiscover() {
    var since = psLastNew || Date.now() - psCfg.maxAgeSec * 1000;
    var coins = psIO("pump.new", {limit: 50, since: since});
    if (!coins) return;
    for (var i = coins.length - 1; i >= 0; i--) {   // 旧的先处理
        var c = coins[i];
        var t = Number(c.time) > 1e12 ? Number(c.time) : Number(c.time) * 1000;
        if (t > psLastNew) { psLastNew = t; psState.lastNew = t; }
        if (psWatch[c.mint] || psState.pos[c.mint] || psState.done[c.mint]) continue;
        psFunnel.found++;
        var creator = String(c.creator || c.user || "");
        psCreatorBump(creator);   // v3.3 P1-4：持久化，重启不失忆
        var sym = String(c.symbol || "").toLowerCase();
        psSymbols[sym] = (psSymbols[sym] || 0) + 1;
        var dk = psDevKey(c.devBuy && c.devBuy.quoteAmount !== null ? c.devBuy.quoteAmount : 0);
        if (dk) (psDevAmts[dk] = psDevAmts[dk] || []).push(Date.now());
        var why = psFilter(c);
        if (why) { psState.done[c.mint] = why; psFunnel.filtered++; var wk = why.replace(/\(.*\)$/, ""); psFilterStat[wk] = (psFilterStat[wk] || 0) + 1; continue; }
        psWatch[c.mint] = {mint: c.mint, symbol: c.symbol, name: c.name, creator: creator, created: t || Date.now(), seen: Date.now(),
            dev: c.devBuy ? c.devBuy.quoteAmount : 0, firstPrice: null, prices: [], progs: []};
        Log("👀 观察", c.symbol, psShort(c.mint), "创建者", creator, "开发者首买", psR(psWatch[c.mint].dev, 3), "SOL 币龄", psSec(Date.now() - t), "#999999");
    }
}

/* ---------- 风控 ---------- */
function psSolBalance() {
    var a = null;
    try { a = exchange.GetAssets(); } catch (e) {}
    if (!Array.isArray(a)) return null;
    for (var i = 0; i < a.length; i++) if (a[i] && a[i].Currency === "SOL") { var n = Number(a[i].Amount); return isFinite(n) && n >= 0 ? n : null; }
    return 0;
}

// 返回不能买的原因（空串 = 可以买）
function psBlock() {
    var rk = psState.risk, now = Date.now();
    if (psState.day !== psDay()) { psState.day = psDay(); psState.dayPnl = 0; }
    if (rk.halted) return "回撤停机：" + rk.haltReason;
    if (rk.reconcileRequired) return "交易/钱包对账锁定：" + (rk.reconcileReason || "须人工核实链上状态");
    if (psReconcileBlock) return "启动对账未通过：" + psReconcileBlock;
    if (psPreflightBlock) return "Jupiter 资金预检未通过：" + psPreflightBlock;
    if (rk.paused) return "手动暂停";
    if (psState.dayPnl <= -psCfg.dailyLossSol) return "当日亏损达上限";
    if (now < rk.coolUntil) return "连亏冷却至 " + _D(rk.coolUntil).slice(11, 16);
    if (now < rk.errUntil) return "接口故障熔断至 " + _D(rk.errUntil).slice(11, 16);
    if (psCycleMs > psCfg.maxLatency * 1000) return "数据延迟 " + psR(psCycleMs / 1000, 1) + "s";
    if (Object.keys(psState.pos).length >= psCfg.maxPos) return "持仓数已满";
    psState.buys = psState.buys.filter(function(t) { return t > now - 3600000; });
    if (psState.buys.length >= psCfg.maxBuysHour) return "每小时买入次数已满";
    if (psSize(true) < psCfg.minBuySol) return "钱包余额或可用仓位不足";
    return "";
}

// 单笔仓位 = min(上限, 权益×比例, 剩余敞口, 钱包可用)
function psSize(checkWallet) {
    var s = Math.min(psCfg.buySol, psEquity() * psCfg.posPct / 100, psCfg.maxExposure - psExposure());
    if (checkWallet && psCfg.mode === 1) {
        var bal = psSolBalance();
        if (bal === null) return 0;
        s = Math.min(s, bal - psCfg.reserveSol - psCfg.priorityFee - psEntryBufferSol);
    }
    return Math.max(0, Math.floor(s * 1e4) / 1e4);
}

// 平仓后更新账户风控
function psAfterClose(p, total) {
    var rk = psState.risk;
    if (total >= 0) { psState.wins++; rk.streak = 0; }
    else {
        psState.losses++; rk.streak++;
        if (rk.streak >= psCfg.lossStreak) {
            rk.coolUntil = Date.now() + psCfg.coolMin * 60000;
            psEvent("warning", "连亏 " + rk.streak + " 次，冷却 " + psCfg.coolMin + " 分钟");
            rk.streak = 0;
        }
    }
    var eq = psEquity();
    if (eq > rk.peak) rk.peak = eq;
    var dd = rk.peak > 0 ? (1 - eq / rk.peak) * 100 : 0;
    if (!rk.halted && dd >= psCfg.maxDrawdown) {
        rk.halted = true;
        rk.haltReason = "权益回撤 " + psR(dd, 1) + "%";
        psEvent("error", "触发回撤停机（" + rk.haltReason + "），停止买入，点“解除停机”恢复@");
    }
    var day = psDay();
    psState.daily[day] = psR((psState.daily[day] || 0) + total, 6);
    psState.equity.push([Date.now(), psR(eq, 6)]);
    if (psState.equity.length > 1000) psState.equity.shift();
    psState.closed.unshift({symbol: p.symbol, mint: p.mint, opened: p.opened, closed: Date.now(), cost: p.cost, back: p.realized,
        ret: p.cost > 0 ? total / p.cost : 0, why: p.lastWhy, flow: p.entryFlow || null});
    delete psFlows[p.mint];
    if (psState.closed.length > 200) psState.closed.length = 200;
}

/* ---------- 观察期动量确认 ---------- */
function psEvaluate() {
    var now = Date.now();
    var block = psBlock();
    var flowBudget = 2;   // 每轮最多给 2 个币查链上成交，免得一轮拖太久
    for (var m in psWatch) {
        var w = psWatch[m];
        var drop = function(why) {
            psState.done[m] = why; psFunnel.rejected++;
            Log("❌ 放弃", w.symbol, psShort(m), why, "|", w.price === undefined ? "未取到行情" : psWatchCtx(w, now), w.flow ? "| " + psFlowText(w.flow) : "", "#999999");
            delete psWatch[m];
        };
        // 不达标先等着，原因变了才记一次日志（币龄未到太常见，不记）
        var wait = function(why, extra) {
            if (w.waitWhy !== why && why !== "币龄未到") Log("⏳ 等待", w.symbol, psShort(m), why, "|", psWatchCtx(w, now), extra ? "| " + extra : "", "#999999");
            w.waitWhy = why; w.blocked = why + (extra ? "（" + extra + "）" : "");
        };
        var age = now - w.created;
        if (age > psCfg.maxAgeSec * 1000) { drop("超龄（最后卡在：" + (w.waitWhy || "未判定") + "）"); continue; }
        if (psSymbols[String(w.symbol || "").toLowerCase()] > 1) { drop("同名仿盘"); continue; }
        if (psDevDup(psDevKey(w.dev), now)) { drop("批量发币(首买" + psDevKey(w.dev) + ")"); continue; }
        if (now < (w.nextInfo || 0)) continue;
        // 接近入场进度的币采样加密，斜率和回落判断才不粗糙
        var fast = w.progress !== undefined && w.progress >= psCfg.minProgress - 3;
        w.nextInfo = now + (fast ? psCfg.fastInfoSec : psCfg.infoSec) * 1000;
        var info = psIO("pump.info", m);
        if (!info) continue;
        if (info.complete || info.migrated) { drop("已毕业"); continue; }
        w.price = Number(info.price); w.progress = Number(info.progress); w.mcap = Number(info.marketCap);
        w.prices.push(w.price); if (w.prices.length > 60) w.prices.shift();
        w.progs.push([now, w.progress]);
        while (w.progs.length > 2 && w.progs[0][0] < now - 300000) w.progs.shift();
        w.rise = w.prices[0] > 0 ? (w.price / w.prices[0] - 1) * 100 : 0;   // 近期涨幅：相对观察池里最早的一次采样
        w.curve = info.bondingCurve;
        if (age >= psCfg.deadSec * 1000 && w.progress < psCfg.deadProgress) { drop("无人问津"); continue; }
        if (age < psCfg.minAgeSec * 1000 || now - w.seen < psCfg.observeSec * 1000) { wait("币龄未到"); continue; }
        if (w.progress < psCfg.minProgress) { wait("进度未到"); continue; }
        if (w.progress > psCfg.maxProgress) { wait("进度过高"); continue; }
        if (psCfg.minRise > 0 && w.rise < psCfg.minRise) { wait("涨幅不足"); continue; }
        if (psCfg.maxRise > 0 && w.rise > psCfg.maxRise) { wait("涨幅过急"); continue; }
        var top = Math.max.apply(null, w.prices);
        if (top > 0 && (1 - w.price / top) * 100 > psCfg.maxPullback) { wait("高点回落中"); continue; }
        // 接力打分放在风控之前：风控拦截时也照样打分，供影子评估积累样本
        var ev = null;
        if (psCfg.flowOn) {
            if (now < (w.flowNext || 0) || flowBudget <= 0) { w.nextInfo = 0; continue; }   // 排队等查成交，下轮行情照查
            flowBudget--;
            w.flowNext = now + 15000;
            ev = psFlowCheck(w, info, Date.now());
            // 链上成交读取可能因限流拖长；过期快照不能继续用于下单。
            if (Date.now() - now > psCfg.maxLatency * 1000) { wait("接力数据过期"); continue; }
            if (ev.veto) { psShadowAdd(w, ev, "否:" + ev.veto); drop(ev.veto); continue; }
            psShadowAdd(w, ev, ev.soft ? "等:" + ev.soft : block ? "拦:" + block.replace(/[:：].*$/, "") : "买");
            if (ev.soft) { wait(ev.soft, psFlowText(w.flow)); continue; }   // 人气还在攒，过会再看，直到超龄
        }
        if (block) {   // 达标但风控不允许，继续观察直到超龄
            if (w.blocked !== block) Log("⏸ 达标但风控拦截", w.symbol, psShort(m), block, "|", psWatchCtx(w, now), "#ff8800");
            w.waitWhy = "风控拦截"; w.blocked = block; continue;
        }
        var size = psSize(true);
        if (size < psCfg.minBuySol) { w.blocked = "钱包可用不足"; continue; }
        var q = psIO("pump.quote", m, "buy", size);
        if (!q || q.venue !== "pump") { drop("无法报价"); continue; }
        if (q.crossesCurve) { drop("越过曲线"); continue; }
        if (Number(q.priceImpactPct) > psCfg.maxImpact) { wait("冲击过大"); continue; }
        var back = psIO("pump.quote", m, "sell", Number(q.amountOut));   // 往返成本：买完立刻卖能拿回多少，再加两笔优先费
        var roundTrip = back ? (1 - (Number(back.amountOut) - 2 * psTxFee() - psAtaFee()) / size) * 100 : 100;   // v3.3：计入 ATA 租金
        if (roundTrip > psCfg.maxRoundTrip) { wait("往返成本过高", "往返" + psR(roundTrip, 1) + "%"); continue; }
        psFunnel.observed++;
        if (w.shadowDec && w.shadowDec !== "买") psShadowAdd(w, ev, "买(延后)", true);   // 首次打分时没买，补一条真实入场点样本
        if (psBuy(w, q, size, roundTrip)) {
            delete psWatch[m]; psState.done[m] = "已买"; psFunnel.bought++;
        } else if (psCfg.mode === 1 && psState.risk.reconcileRequired) {
            delete psWatch[m]; psState.done[m] = "买入结果待对账";
        } else {
            w.nextInfo = Date.now() + psCfg.infoSec * 1000;
            w.blocked = "买入未成交，等待重试";
        }
        block = psBlock();
    }
}

/* ---------- 链上接力指标（直接查 Solana 节点） ---------- */
var psRpcUrls = [];
var psRpcIndex = 0;
var psFlows = {};        // mint -> 持仓期间的成交缓存 {head, trades, last}
var psFlowMs = 0;        // 本轮花在查链上成交的时间（不计入数据延迟）
var PS_PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// 公共 RPC 逐项计费，JSON-RPC 批量请求也按子请求数占用额度。
var psRpcTokens = 8, psRpcRefillAt = Date.now();
var psRpcStats = {calls: 0, limited: 0, failed: 0, waitMs: 0};

function psRpcAcquire(units, deadline) {
    while (Date.now() < deadline) {
        var now = Date.now();
        psRpcTokens = Math.min(8, psRpcTokens + (now - psRpcRefillAt) * 8 / 1000);
        psRpcRefillAt = now;
        if (psRpcTokens >= units) { psRpcTokens -= units; return true; }
        var wait = Math.min(1000, Math.ceil((units - psRpcTokens) * 1000 / 8));
        if (now + wait > deadline) return false;
        Sleep(wait); psRpcStats.waitMs += wait;
    }
    return false;
}

function psRpc(body) {
    if (!psRpcUrls.length) psRpcUrls = String(exchange.IO("base") || "").split(",").map(function(x) { return x.trim(); }).filter(function(x) { return x; });
    if (!psRpcUrls.length) { psRpcStats.failed++; return null; }
    var deadline = Date.now() + 8000, units = Array.isArray(body) ? body.length : 1;
    psRpcStats.calls++;
    for (var i = 0; i < 3; i++) {
        if (!psRpcAcquire(units, deadline)) break;
        var r = null, j = null;
        var idx = psRpcIndex % psRpcUrls.length;
        try { r = HttpQuery(psRpcUrls[idx], {method: "POST", body: JSON.stringify(body), headers: {"Content-Type": "application/json"}, timeout: Math.min(6000, Math.max(1000, deadline - Date.now()))}); } catch (e) {}
        try { j = JSON.parse(r); } catch (e) {}
        if (j && (Array.isArray(j) || !j.error)) { psRpcIndex = idx; return j; }
        var limited = (j && j.error && Number(j.error.code) === 429) || /(?:^|\D)429(?:\D|$)|too many requests|rate limit/i.test(String(r || ""));
        if (limited) psRpcStats.limited++;
        psRpcIndex = (idx + 1) % psRpcUrls.length;
        var backoff = Math.min(2000, 400 * Math.pow(2, i));
        if (Date.now() + backoff >= deadline) break;
        Sleep(backoff); psRpcStats.waitMs += backoff;
    }
    psRpcStats.failed++;
    return null;
}

/* pump 程序每笔买卖都会发 TradeEvent，里面有真实交易人、方向、SOL 和代币数量，
 * 比“付手续费的钱包 + 余额差”准确：交易机器人/打包工具代付手续费时不会认错人，SOL 也不混入优先费和租金。
 * 布局：8 字节标识 | mint 32 | sol_amount u64 | token_amount u64 | is_buy u8 | user 32 | timestamp i64 | ... */
var PS_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var PS_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var PS_TRADE_DISC = [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee];
function psB64(s) {
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
        var v = PS_B64.indexOf(s.charAt(i));
        if (v < 0) continue;
        buf = (buf << 6) | v; bits += 6;
        if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); buf &= (1 << bits) - 1; }
    }
    return out;
}
function psB58Enc(bytes) {
    var d = [];
    for (var i = 0; i < bytes.length; i++) {
        var carry = bytes[i];
        for (var j = 0; j < d.length; j++) { carry += d[j] * 256; d[j] = carry % 58; carry = Math.floor(carry / 58); }
        while (carry) { d.push(carry % 58); carry = Math.floor(carry / 58); }
    }
    var s = "";
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) s += "1";
    for (var q = d.length - 1; q >= 0; q--) s += PS_B58.charAt(d[q]);
    return s;
}
function psB58Dec(s) {
    var b = [];
    for (var i = 0; i < s.length; i++) {
        var carry = PS_B58.indexOf(s.charAt(i));
        if (carry < 0) return null;
        for (var j = 0; j < b.length; j++) { carry += b[j] * 58; b[j] = carry & 255; carry >>= 8; }
        while (carry) { b.push(carry & 255); carry >>= 8; }
    }
    for (var k = 0; k < s.length && s.charAt(k) === "1"; k++) b.push(0);
    return b.reverse();
}
function psU64(b, o) { var lo = 0, hi = 0; for (var i = 3; i >= 0; i--) { lo = lo * 256 + b[o + i]; hi = hi * 256 + b[o + 4 + i]; } return hi * 4294967296 + lo; }
function psTradeEvent(b, off) {
    if (!b || b.length < off + 129) return null;
    for (var i = 0; i < 8; i++) if (b[off + i] !== PS_TRADE_DISC[i]) return null;
    var o = off + 8;
    return {mint: psB58Enc(b.slice(o, o + 32)), sol: psU64(b, o + 32) / 1e9, isBuy: b[o + 48] === 1, user: psB58Enc(b.slice(o + 49, o + 81))};
}

// 一笔交易里该 mint 的成交（可能多笔：打包交易里多人同时买）；evt 表示是否由 TradeEvent 解析
function psTxTrades(x, mint, curve) {
    if (!x || !x.meta || x.meta.err) return [];
    var t = x.blockTime * 1000, out = [];
    (x.meta.logMessages || []).forEach(function(l) {
        if (l.indexOf("Program data: ") !== 0) return;
        var e = psTradeEvent(psB64(l.slice(14)), 0);
        if (e && e.mint === mint) out.push({t: t, slot: x.slot, wallet: e.user, side: e.isBuy ? "buy" : "sell", sol: e.sol, evt: true});
    });
    if (!out.length) (x.meta.innerInstructions || []).forEach(function(g) {   // 新版 pump 用 emit_cpi：事件藏在自调用指令数据里，前 8 字节是事件指令标记
        (g.instructions || []).forEach(function(ix) {
            if (ix.parsed || !ix.data || ix.data.length < 150) return;
            var e = psTradeEvent(psB58Dec(ix.data), 8);
            if (e && e.mint === mint) out.push({t: t, slot: x.slot, wallet: e.user, side: e.isBuy ? "buy" : "sell", sol: e.sol, evt: true});
        });
    });
    if (out.length) return out;
    // 兜底：代币变动最大的非曲线钱包是交易人，SOL 用曲线账户余额变化（不含手续费和租金）
    var m = x.meta, d = {};
    (m.preTokenBalances || []).forEach(function(q) { if (q.mint === mint) d[q.owner] = (d[q.owner] || 0) - (q.uiTokenAmount.uiAmount || 0); });
    (m.postTokenBalances || []).forEach(function(q) { if (q.mint === mint) d[q.owner] = (d[q.owner] || 0) + (q.uiTokenAmount.uiAmount || 0); });
    var best = null;
    for (var w in d) if (w !== curve && d[w] && (!best || Math.abs(d[w]) > Math.abs(d[best]))) best = w;
    if (!best) return [];
    var keys = x.transaction.message.accountKeys, ci = -1;
    for (var i = 0; i < keys.length; i++) if ((keys[i].pubkey || keys[i]) === curve) { ci = i; break; }
    var sol = ci >= 0 ? Math.abs(m.postBalances[ci] - m.preBalances[ci]) / 1e9 : 0;
    return [{t: t, slot: x.slot, wallet: best, side: d[best] > 0 ? "buy" : "sell", sol: sol, evt: false}];
}

// 批量取交易：节点按每秒请求数限流（批量里每笔都算一次），每批 5 笔，被限流的稍后重试
function psGetTxs(sigs) {
    var txs = [], todo = sigs.slice();
    for (var round = 0; round < 3 && todo.length; round++) {
        var failed = [];
        for (var b = 0; b < todo.length; b += 5) {
            var part = todo.slice(b, b + 5);
            var res = psRpc(part.map(function(sig, k) {
                return {jsonrpc: "2.0", id: k, method: "getTransaction", params: [sig, {encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed"}]};
            }));
            if (!Array.isArray(res)) { failed = failed.concat(part); continue; }
            res.forEach(function(e) { if (e && e.result) txs.push(e.result); else if (e && e.error) failed.push(part[e.id]); });
            Sleep(150);
        }
        todo = failed;
        if (todo.length) Sleep(600);
    }
    return {txs: txs, missed: todo.length};
}

// mint 的曲线账户上 untilSig 之后的成交：[{t, wallet, side, sol}]，按时间升序；失败返回 null
// truncated = 成交太多只取到最近 maxTx 笔，统计窗口要按实际覆盖的时间缩短
function psFetchTrades(mint, curve, untilSig, maxTx) {
    var opt = {limit: Math.min(100, maxTx * 2), commitment: "confirmed"};   // 默认 finalized 要晚十几秒，最新成交看不到
    if (untilSig) opt.until = untilSig;
    var sg = psRpc({jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [curve, opt]});
    if (!sg || !sg.result) return null;
    var ok = sg.result.filter(function(s) { return !s.err; });
    var sigs = ok.slice(0, maxTx);
    var g = psGetTxs(sigs.map(function(s) { return s.signature; }));
    var trades = [], evt = 0;
    g.txs.forEach(function(x) { psTxTrades(x, mint, curve).forEach(function(t) { trades.push(t); if (t.evt) evt++; }); });
    trades.sort(function(a, b) { return a.t - b.t; });
    return {trades: trades, head: sg.result.length ? sg.result[0].signature : untilSig, missed: g.missed,
        truncated: ok.length > maxTx || sg.result.length >= opt.limit, cover: trades.length ? evt / trades.length : 1};
}

// v3.3 P1-5：窗口固定不缩短。原版在成交被截断时把窗口缩到 max(5s, …)，
// 而"最热门的币"恰恰是最容易被截断的 → 统计变成 5 秒噪声 → 最好的币被系统性判成噪声
function psFlowStats(trades, now, winSec, truncated) {
    var win = winSec * 1000;
    var cut = now - win, half = now - win / 2;
    var s = {buys: 0, sells: 0, buySol: 0, sellSol: 0, uniq: 0, newOld: 0, newRecent: 0, bigSells: 0, absorb: null,
             winSec: Math.round(win / 1000), lowCover: truncated ? 1 : 0, burst: 0, neverSold: 0};
    var seen = {}, buyersAll = {}, sellersAll = {}, buyTs = [];
    trades.forEach(function(t, i) {
        if (t.side === "buy") buyersAll[t.wallet] = 1; else sellersAll[t.wallet] = 1;
        if (t.t < cut) { if (t.side === "buy") seen[t.wallet] = 1; return; }
        if (t.side === "buy") {
            s.buys++; s.buySol += t.sol; buyTs.push(t.t);
            if (!seen[t.wallet]) { seen[t.wallet] = 1; s.uniq++; if (t.t >= half) s.newRecent++; else s.newOld++; }
            return;
        }
        s.sells++; s.sellSol += t.sol;
        // 大单卖出后有没有人接：只看已经过了 absorbSec 的大单
        if (t.sol >= psCfg.bigSell && t.t <= now - psCfg.absorbSec * 1000) {
            var after = 0;
            for (var j = i + 1; j < trades.length && trades[j].t <= t.t + psCfg.absorbSec * 1000; j++) if (trades[j].side === "buy") after += trades[j].sol;
            var ratio = after / t.sol;
            s.bigSells++;
            s.absorb = s.absorb === null ? ratio : Math.min(s.absorb, ratio);
        }
    });
    s.netSol = s.buySol - s.sellSol;
    s.ratio = s.sells ? s.buys / s.sells : s.buys;
    s.growth = s.newOld ? s.newRecent / s.newOld : (s.newRecent ? 9 : 0);
    // v3.3 新增两个"零成本"反操纵指标（只用已取到的成交，不额外花 RPC）
    buyTs.sort(function(a, b) { return a - b; });
    var burst = 0;
    for (var i3 = 1; i3 < buyTs.length; i3++) if (buyTs[i3] - buyTs[i3 - 1] <= 250) burst++;
    s.burst = buyTs.length > 1 ? burst / (buyTs.length - 1) : 0;      // 250ms 内连续买入占比 = 同 slot 打包
    var nb = 0, ns = 0, w;
    for (w in buyersAll) { nb++; if (sellersAll[w]) ns++; }
    s.neverSold = nb ? 1 - ns / nb : 0;                                // 只买不卖的钱包占比 = 待砸盘捆绑仓
    return s;
}

// 持仓按钱包合并（同一人多个代币账户算一起），曲线自己的账户按 owner 精确排除；
// 返回 {top10, top1, owners: {钱包: 占比%}}
function psTopHolders(mint, info) {
    var r = psRpc({jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [mint, {commitment: "confirmed"}]});
    if (!r || !r.result) return null;
    var supply = Number(info.tokenTotalSupply);
    if (!(supply > 0)) return null;
    var accts = r.result.value;
    var mres = psRpc({jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [accts.map(function(a) { return a.address; }), {encoding: "jsonParsed", commitment: "confirmed"}]});
    var vals = mres && mres.result ? mres.result.value : null;
    var owners = {}, curve = info.bondingCurve, curveAmt = 0, maxAmt = 0, maxKey = null;
    accts.forEach(function(a, i) {
        var v = vals && vals[i], owner = v && v.data && v.data.parsed ? v.data.parsed.info.owner : null;
        var amt = Number(a.uiAmount) || 0;
        if (owner === curve) { curveAmt += amt; return; }
        var key = owner || "acct:" + a.address;
        owners[key] = (owners[key] || 0) + amt;
        if (!vals && amt > maxAmt) { maxAmt = amt; maxKey = key; }
    });
    if (!vals && maxKey) { curveAmt += owners[maxKey] || 0; delete owners[maxKey]; }  // 读不到 owner：最大账户当曲线
    // v3.3 P1-3：分母用流通量（总量-曲线持仓）。曲线期只流通 24%(10%)~78%(95%)，
    // 用 1e9 做分母会让所有集中度门槛放水 1.5~4 倍，15 分"筹码分散"几乎恒为满分
    var floatAmt = Math.max(1, supply - curveAmt);
    if (curveAmt <= 0) floatAmt = Math.max(1, supply * 0.5);
    var arr = Object.keys(owners).map(function(k) { return owners[k]; }).sort(function(a, b) { return b - a; });
    var pct = {};
    for (var k in owners) pct[k] = owners[k] / floatAmt * 100;
    return {top10: arr.slice(0, 10).reduce(function(x, y) { return x + y; }, 0) / floatAmt * 100,
            top1: (arr[0] || 0) / floatAmt * 100, owners: pct,
            floatPct: floatAmt / supply * 100, curveAmt: curveAmt};
}

// v3.3 P1-2：抢筹/捆绑钱包检测。原版只看「创建 slot 及下一个 slot」，捆绑盘铺到 slot 2~20 就完全失效；
// 且签名数 ≥1000 时静默 return null（= 相当于不检查），而热门的币恰好全落在这个分支
function psEarlyBuyers(mint, curve) {
    var sg = psRpc({jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [curve, {limit: 1000, commitment: "confirmed"}]});
    if (!sg || !sg.result || !sg.result.length) return null;
    if (sg.result.length >= 1000) return {unknown: true, set: {}, n: 0};   // 翻不到创建 slot：标记"无法确认"
    var first = sg.result[sg.result.length - 1].slot;
    var win = Math.max(1, psCfg.sniperSlots);
    var early = sg.result.filter(function(s) { return !s.err && s.slot <= first + win; })
        .map(function(s) { return s.signature; }).slice(0, 40);
    var g = psGetTxs(early);
    if (g.missed > early.length / 2) return {unknown: true, set: {}, n: 0};
    var set = {}, n = 0;
    g.txs.forEach(function(x) { psTxTrades(x, mint, curve).forEach(function(t) { if (t.side === "buy" && !set[t.wallet]) { set[t.wallet] = 1; n++; } }); });
    return {set: set, n: n, unknown: false};
}

/* ---------- v3.3 新增：资金同源聚类（对抗"20 个同源钱包对倒刷分"） ----------
 * 评分制的 6 个输入（斜率/净流入/独立买家/买卖比/增速/分散）全部可以用一批自己控制的钱包刷满。
 * 唯一刷不掉的是"资金来源"：这些钱包的第一个 SOL 都来自同一个地址。
 * 成本控制：只在评分已过线（马上要下单）时才查；每个钱包结果持久缓存 creatorDays 天；每轮限新查 clusterBudget 个。
 */
var psFundCache = null;
function psFundKey() { return "pumpFund_" + psCfg.namespace; }
function psFundLoad() {
    if (psFundCache) return psFundCache;
    var c = _G(psFundKey());
    psFundCache = (c && typeof c === "object") ? c : {};
    return psFundCache;
}
function psFundSave() { _G(psFundKey(), psFundCache || {}); }
function psFundingSource(addr, now) {
    var sg = psRpc({jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [addr, {limit: 1000, commitment: "confirmed"}]});
    if (!sg || !sg.result) return null;
    if (!sg.result.length) return addr;                                  // 无历史 = 全新钱包，自己算一族
    var oldest = sg.result[sg.result.length - 1].signature;
    var tx = psRpc({jsonrpc: "2.0", id: 1, method: "getTransaction", params: [oldest, {encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed"}]});
    if (!tx || !tx.result) return null;
    var keys = tx.result.transaction.message.accountKeys || [];
    var payer = keys.length ? (keys[0].pubkey || keys[0]) : addr;
    return payer === addr ? addr : payer;                                 // 首个交易的付费方 = 出资方
}
// 返回 {cluster: 最大同源簇合计占流通量%, covered: 已解析数, top: [钱包]}
function psClusterCheck(h, wallets, now, budget) {
    var res = {cluster: 0, covered: 0, total: wallets.length, top: []};
    if (!psCfg.clusterOn || !wallets.length) return res;
    var c = psFundLoad(), groups = {}, fresh = 0;
    for (var i = 0; i < wallets.length; i++) {
        var w = wallets[i];
        if (h.owners[w] === undefined) continue;
        var e = c[w], src = null;
        if (e && now - e.t < psCfg.creatorDays * 86400000) src = e.src;   // 缓存命中不花预算
        else if (fresh < Math.max(1, budget)) { fresh++; src = psFundingSource(w, now); if (src) { c[w] = {src: src, t: now}; } }
        if (!src) continue;
        res.covered++;
        (groups[src] = groups[src] || []).push(w);
    }
    for (var k in groups) {
        var pct = 0;
        for (var j = 0; j < groups[k].length; j++) pct += h.owners[groups[k][j]] || 0;
        if (pct > res.cluster) { res.cluster = pct; res.top = groups[k]; }
    }
    if (fresh) psFundSave();
    return res;
}

// 曲线进度斜率（百分点/分钟），用约 1 分钟前的采样
function psProgSlope(w, now) {
    var p = w.progs, ref = null;
    for (var i = p.length - 1; i >= 0; i--) { ref = p[i]; if (now - p[i][0] >= 60000) break; }
    if (!ref || now - ref[0] < 10000) return 0;
    return (w.progress - ref[1]) / ((now - ref[0]) / 60000);
}

// 打分 0~100：进度斜率 25 + 净流入 20 + 独立买家 20 + 买卖比 10 + 新买家增速 10 + 筹码分散 15
function psScore(s) {
    var c = function(x) { return isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; };
    var parts = {
        slope: c(s.slope / psCfg.goodSlope) * 25,
        net: c(s.netSol / psCfg.goodNetSol) * 20,
        buyers: c(s.uniq / psCfg.goodBuyers) * 20,
        ratio: c((s.ratio - 1) / 1.5) * 10,
        growth: c(s.growth) * 10,
        spread: (1 - c((s.top10 - 35) / 35)) * 15   // v3.3：top10 现为"占流通量%"，35% 满分、70% 归零
    };
    var total = 0;
    for (var k in parts) { parts[k] = psR(parts[k], 1); total += parts[k]; }
    return {total: psR(total, 1), parts: parts};
}

// 买入前检查；返回 {s: 统计, veto: 一票否决原因, soft: 暂不达标原因}
function psFlowCheck(w, info, now) {
    var t0 = Date.now();
    try { return psFlowCheckInner(w, info, now); } finally { psFlowMs += Date.now() - t0; }
}
function psFlowCheckInner(w, info, now) {
    var f = psFetchTrades(w.mint, info.bondingCurve, null, psCfg.flowTx);
    var h = psTopHolders(w.mint, info);
    if (!f || !h || f.missed > psCfg.flowTx / 2) return {soft: "接力数据读取失败"};
    if (!w.earlyTried) { w.earlyTried = true; w.early = psEarlyBuyers(w.mint, info.bondingCurve); }
    var s = psFlowStats(f.trades, now, psCfg.flowWin, f.truncated);
    s.top10 = h.top10; s.top1 = h.top1; s.floatPct = h.floatPct; s.cover = f.cover;
    s.sniper = null;
    if (w.early && !w.early.unknown) { s.sniper = 0; for (var k in w.early.set) s.sniper += h.owners[k] || 0; }
    s.slope = psProgSlope(w, now);
    var sc = psScore(s);
    s.score = sc.total; s.parts = sc.parts;
    w.flow = s;
    w.flowHead = f.head;
    // —— 一票否决（v3.3 增加 3 条）——
    if (f.trades.some(function(t) { return t.wallet === w.creator && t.side === "sell"; })) return {s: s, veto: "开发者已卖出"};
    if (h.top1 > psCfg.maxTop1) return {s: s, veto: "单一持仓过大(占流通" + psR(h.top1, 1) + "%)"};
    if (h.top10 > psCfg.maxTop10) return {s: s, veto: "前十持仓过重(占流通" + psR(h.top10, 1) + "%)"};
    if (s.sniper !== null && s.sniper > psCfg.maxSniper) return {s: s, veto: "开盘抢筹仓位过重"};
    if (s.sniper === null && psCfg.sniperUnknownVeto) return {s: s, veto: "抢筹无法确认"};
    if (s.absorb !== null && s.absorb < psCfg.minAbsorb) return {s: s, veto: "大单卖出无人接"};
    if (s.burst >= psCfg.burstVeto && s.neverSold >= psCfg.neverSoldVeto)
        return {s: s, veto: "疑似对倒/捆绑(聚集" + psR(s.burst * 100, 0) + "% 只买不卖" + psR(s.neverSold * 100, 0) + "%)"};
    if (s.slope < psCfg.minSlope) return {s: s, soft: "斜率不足(" + psR(s.slope, 1) + "pp/分)"};
    if (s.uniq < psCfg.minBuyers) return {s: s, soft: "独立买家不足"};
    if (s.score < psCfg.minScore) return {s: s, soft: "评分不足"};
    // —— 只有分数已过线、马上要下单时，才为"资金同源"花 RPC ——
    var cand = Object.keys(h.owners).sort(function(a, b) { return (h.owners[b] || 0) - (h.owners[a] || 0); })
        .slice(0, Math.max(4, psCfg.clusterN));
    var cl = psClusterCheck(h, cand, now, psCfg.clusterBudget);
    s.cluster = cl.cluster; s.clusterCovered = cl.covered;
    w.flow = s;
    if (cl.cluster > psCfg.maxCluster)
        return {s: s, veto: "资金同源簇占流通" + psR(cl.cluster, 1) + "%(" + cl.top.length + "个钱包)"};
    return {s: s};
}

function psFlowText(s) {
    if (!s) return "";
    return (s.score === undefined ? "" : "评分" + s.score + " 斜率" + psR(s.slope, 2) + "%/分 ") +
        "近" + s.winSec + "s 新买家" + s.uniq + "(前半" + s.newOld + "/后半" + s.newRecent + " 增速" + psR(s.growth, 2) + ")" +
        " 买" + s.buys + "笔" + psR(s.buySol, 2) + "SOL/卖" + s.sells + "笔" + psR(s.sellSol, 2) + "SOL 净流入" + psR(s.netSol, 2) + " 比" + psR(s.ratio, 2) +
        (s.absorb === null ? " 无大单卖出" : " 大单" + s.bigSells + "笔承接" + psR(s.absorb, 2)) +
        (s.top10 === undefined ? "" : " 前10占" + psR(s.top10, 1) + "% 第1占" + psR(s.top1, 1) + "%") +
        (s.sniper === null || s.sniper === undefined ? " 抢筹未知" : " 抢筹钱包占" + psR(s.sniper, 1) + "%") +
        (s.cover === undefined ? "" : " 事件解析率" + psR(s.cover * 100, 0) + "%") +
        (s.burst === undefined ? "" : " 聚集" + psR(s.burst * 100, 0) + "% 只买不卖" + psR(s.neverSold * 100, 0) + "%") +
        (s.cluster === undefined ? "" : " 同源簇" + psR(s.cluster, 1) + "%");
}

// 持仓期间：返回应离场的原因（空串 = 继续持有）
function psFlowExit(p, now) {
    var fl = psFlows[p.mint];
    if (!fl) fl = psFlows[p.mint] = {head: p.flowHead || null, trades: [], last: 0};
    if (now - fl.last < psCfg.flowHoldSec * 1000) return "";
    fl.last = now;
    if (!p.curve) return "";
    var t0 = Date.now();
    var f = psFetchTrades(p.mint, p.curve, fl.head, 30);
    psFlowMs += Date.now() - t0;
    if (!f) return "";
    fl.head = f.head;
    fl.trades = fl.trades.concat(f.trades).filter(function(t) { return t.t > now - 300000; });
    if (f.trades.some(function(t) { return t.wallet === p.creator && t.side === "sell"; })) return "开发者卖出";
    var r10 = {buy: 0, sell: 0};
    fl.trades.forEach(function(t) { if (t.t > now - 10000) r10[t.side] += t.sol; });
    if (r10.sell >= psCfg.dumpSol && r10.buy < r10.sell * 0.3) return "大户出货无人接 " + psR(r10.sell, 2) + " SOL";
    if (now - p.opened > psCfg.flowWin * 1000) {
        var s = psFlowStats(fl.trades, now, psCfg.flowWin, false);
        if (s.uniq === 0 && s.sells > s.buys) return "接力中断";
    }
    return "";
}

/* ---------- v3.3 新增：代币账户（ATA）租金 ----------
 * 每开一个新币持仓都要租一个 token account = 0.00203928 SOL。
 * 0.05 SOL 的单子这一项就是 4.08%，而原版 psTxFee() 完全没算 → 8% 的往返成本门槛形同虚设。
 * pAtaReclaim=1 时卖出后尝试关闭账户回收（不计入成本模型）；=0 时按纯成本计入。 */
function psAtaFee() { return psCfg.ataReclaim ? 0 : psCfg.ataCost; }
function psTryCloseAta(mint) {
    if (psCfg.mode !== 1 || !psCfg.ataReclaim) return;
    var ok = false, err = "";
    try { ok = !!exchange.IO("pump.closeAta", mint); } catch (e) { err = e.message || String(e); }
    if (!ok) { try { ok = !!exchange.IO("pump.closeata", mint); } catch (e2) { err = err || (e2.message || String(e2)); } }
    Log(ok ? "🧹 已关闭代币账户 " + psShort(mint) + "，回收 " + psCfg.ataCost + " SOL"
           : "⚠️ 代币账户未关闭 " + psShort(mint) + "（" + psCfg.ataCost + " SOL 租金未回收）" + (err ? " err=" + err : ""),
        ok ? "#00a000" : "#ff8800");
}

/* ---------- 优先费 ---------- */
var psFeeCache = {t: 0, v: 0};
// 按 pump 程序近期优先费 75 分位动态定价，夹在 [最低优先费, 优先费上限] 之间；关闭时用固定值
function psPrioFee() {
    if (!psCfg.dynFee) return psCfg.priorityFee;
    if (psFeeCache.v && Date.now() - psFeeCache.t < 30000) return psFeeCache.v;
    var r = psRpc({jsonrpc: "2.0", id: 1, method: "getRecentPrioritizationFees", params: [[PS_PUMP_PROGRAM]]});
    var v = psCfg.priorityFee;
    if (r && r.result && r.result.length) {
        var fees = r.result.map(function(x) { return Number(x.prioritizationFee) || 0; }).sort(function(a, b) { return a - b; });
        var p75 = fees[Math.floor(fees.length * 0.75)] || 0;   // 微 lamports / 计算单元
        v = Math.max(psCfg.minPriorityFee, Math.min(psCfg.priorityFee, p75 * psCfg.feeCu / 1e6 / 1e9));
    }
    psFeeCache = {t: Date.now(), v: v};
    return v;
}
function psTxFee() { return psPrioFee() + 0.000005; }   // 每笔交易：优先费 + 基础签名费

/* ---------- 影子评估：不下单，记录每个候选币的特征与之后 3/10/30 分钟的可卖价值 ---------- */
var psShadow = [];
var psShadowSaved = 0, psShadowLog = Date.now();
var PS_SH_H = [180, 600, 1800];
function psShadowKey() { return "pumpShadow_" + psCfg.namespace; }
function psIOSoft() { try { return exchange.IO.apply(exchange, Array.prototype.slice.call(arguments)); } catch (e) { return null; } }   // 不计入接口熔断
function psShadowAdd(w, ev, dec, force) {
    if (!psCfg.shadowOn || !ev || !ev.s || (w.shadowDec && !force)) return;
    var q = psIOSoft("pump.quote", w.mint, "buy", psCfg.buySol);
    if (!q || !(Number(q.amountOut) > 0)) return;
    w.shadowDec = dec;
    var s = ev.s;
    psShadow.unshift({t: Date.now(), mint: w.mint, sym: w.symbol, dec: dec, score: s.score, parts: s.parts, slope: psR(s.slope, 2), net: psR(s.netSol, 2),
        uniq: s.uniq, ratio: psR(s.ratio, 2), growth: psR(s.growth, 2), top10: psR(s.top10, 1), top1: psR(s.top1, 1), sniper: s.sniper === null ? null : psR(s.sniper, 1),
        cover: psR(s.cover, 2), prog: psR(w.progress, 1), age: Math.round((Date.now() - w.created) / 1000), size: psCfg.buySol, tokens: Number(q.amountOut),
        fee: psR(2 * psTxFee() + psAtaFee(), 6), r: {}, grad: false});
    if (psShadow.length > 1500) psShadow.length = 1500;
}
// v3.3 P0-3：毕业/迁移样本的收益，按策略**自己的出场规则**（pExitProgress 前退出）用曲线定价反算。
// 原版记 null 后被 psShadowAgg 剔除 → 把最赚钱的一批样本从均值/胜率里删掉，统计必然系统性低估
function psGradReturn(progPct) {
    var p = Math.max(0.01, Math.min(1, (Number(progPct) || 0) / 100));
    var ep = Math.max(0.5, Math.min(1, psCfg.exitProgress > 1 ? psCfg.exitProgress / 100 : psCfg.exitProgress)); // 注意 pExitProgress 是百分数 95
    var R0 = 85 * p, R1 = 85 * ep;
    return Math.pow((30 + R1) / (30 + R0), 2) - 1;      // 价格比 (30+R1)²/(30+R0)²
}
// 假设当时买入 size SOL，现在全部卖出的收益率（扣交易费+可能的 ATA）；拿不到价但已毕业时按出场规则记账
function psShadowValue(x) {
    var q = psIOSoft("pump.quote", x.mint, "sell", x.tokens);
    if (q) return psR((Number(q.amountOut) - x.fee) / x.size - 1, 4);
    var info = psIOSoft("pump.info", x.mint);
    if (info && (info.complete || info.migrated)) {
        x.grad = true;
        return psR((1 + psGradReturn(x.prog)) * (1 - 0.0125) - 1 - x.fee / x.size, 4);
    }
    var cap = psReserveCap(info);
    return cap === null ? null : psR((cap - x.fee) / x.size - 1, 4);
}
function psShadowTick() {
    if (!psCfg.shadowOn) return;
    var now = Date.now(), n = 0;
    for (var i = psShadow.length - 1; i >= 0 && n < 4; i--) {   // 旧的先算
        var x = psShadow[i];
        if (now - x.t > 3600000 && x.r[1800] !== undefined) continue;
        for (var k = 0; k < PS_SH_H.length; k++) {
            var h = PS_SH_H[k];
            if (x.r[h] !== undefined) continue;
            if (now - x.t < h * 1000) break;
            x.r[h] = psShadowValue(x);   // v3.3：不再跳过毕业样本
            n++;
            break;
        }
    }
    if (now - psShadowSaved > 60000) { _G(psShadowKey(), psShadow); psShadowSaved = now; }
    if (now - psShadowLog > 3600000) {
        psShadowLog = now;
        var rows = psShadowStats().byScore.filter(function(r) { return r[1] > 0; });
        if (rows.length) Log("🧪 影子评估（10 分钟收益）" + rows.map(function(r) { return r[0] + " 样本" + r[1] + " 均值" + psR(r[3] * 100, 1) + "% 胜率" + psR(r[5] * 100, 0) + "%"; }).join("；"), "#7a00cc");
    }
}
// 分组统计：[组名, 样本数(10分钟已出), 3分均值, 10分均值, 30分均值, 10分胜率, 10分最差, 毕业数]
function psShadowAgg(name, list) {
    var avg = function(h) { var v = list.filter(function(x) { return typeof x.r[h] === "number"; }).map(function(x) { return x.r[h]; }); return v.length ? psR(v.reduce(function(a, b) { return a + b; }, 0) / v.length, 4) : null; };
    var v10 = list.filter(function(x) { return typeof x.r[600] === "number"; }).map(function(x) { return x.r[600]; });
    return [name, v10.length, avg(180), avg(600), avg(1800), v10.length ? psR(v10.filter(function(r) { return r > 0; }).length / v10.length, 3) : null,
        v10.length ? Math.min.apply(null, v10) : null, list.filter(function(x) { return x.grad; }).length];
}
function psShadowStats() {
    var byScore = [["<60", 0, 60], ["60~70", 60, 70], ["70~80", 70, 80], ["80~90", 80, 90], ["≥90", 90, 1e9]].map(function(b) {
        return psShadowAgg("评分" + b[0], psShadow.filter(function(x) { return x.score >= b[1] && x.score < b[2]; }));
    });
    var groups = {};
    psShadow.forEach(function(x) { var g = x.dec.replace(/^拦:.*/, "买(风控拦截)"); (groups[g] = groups[g] || []).push(x); });
    var byDec = Object.keys(groups).map(function(g) { return psShadowAgg(g, groups[g]); }).sort(function(a, b) { return b[1] - a[1]; });
    return {byScore: byScore, byDec: byDec};
}
// 导出已有 10 分钟结果的样本到日志（CSV），复制出去做阈值分析
function psShadowCsv() {
    var done = psShadow.filter(function(x) { return x.r[600] !== undefined; }).slice(0, 300);
    Log("影子样本 CSV（" + done.length + " 条，最新在前）\ntime,mint,symbol,decision,score,slope,netSol,buyers,ratio,growth,top10,top1,sniper,cover,progress,age,ret3m,ret10m,ret30m,graduated\n" +
        done.map(function(x) {
            return [_D(x.t), x.mint, String(x.sym).replace(/,/g, " "), x.dec, x.score, x.slope, x.net, x.uniq, x.ratio, x.growth, x.top10, x.top1, x.sniper, x.cover, x.prog, x.age,
                x.r[180], x.r[600], x.r[1800], x.grad ? 1 : 0].join(",");
        }).join("\n"));
}

/* ---------- 下单 ---------- */
function psHolding(mint) {
    var hs = psIO("pump.holdings") || [];
    for (var i = 0; i < hs.length; i++) if (hs[i].mint === mint && Number(hs[i].amount) > 0) return hs[i];
    return null;
}

function psBuy(w, q, size, roundTrip) {
    var tokens, cost, tx;
    if (psCfg.mode === 1) {
        if (psState.risk.reconcileRequired || psState.risk.pendingMint) return false;
        psState.risk.reconcileRequired = true; psState.risk.pendingMint = w.mint; psState.risk.pendingSide = "buy";
        psState.risk.reconcileReason = "买入提交中 " + w.symbol + " " + psShort(w.mint);
        psState.pendingIntent = {side: "buy", mint: w.mint, symbol: w.symbol, amountSol: size, expectedTokens: Number(q && q.amountOut) || 0, quotePrice: Number(q && q.price) || 0, started: Date.now()};
        psSave();
        var r = psIO("pump.buy", w.mint, size, {slippage: psCfg.slippage, priorityFee: psPrioFee(), wait: true});
        if (!r || r.pending || !(Number(r.tokenAmount) > 0) || !(Number(r.solAmount) > 0)) {
            psState.risk.reconcileReason = "买入结果未知 " + w.symbol + " " + psShort(w.mint) + (r && (r.txHash || r.signature) ? " tx=" + (r.txHash || r.signature) : "（无交易哈希）");
            psEvent("error", psState.risk.reconcileReason + "；暂停新仓，先核实链上状态并修复账本"); psSave(); return false;
        }
        tokens = Number(r.tokenAmount); cost = Number(r.solAmount); tx = r.txHash || r.signature || "";
    } else {
        if (psCfg.paperDelay > 0) Sleep(psCfg.paperDelay);
        var q2 = psIO("pump.quote", w.mint, "buy", size);
        if (!q2 || Number(q2.amountOut) < Number(q.amountOut) * (1 - psCfg.slippage)) { psEvent("warning", "模拟买入失败（延迟后无法报价或超出滑点）" + w.symbol + " " + psShort(w.mint)); return false; }
        tokens = Number(q2.amountOut); cost = size + psTxFee() + psAtaFee(); tx = "模拟(延迟" + psCfg.paperDelay + "ms 重报价，含交易费与ATA)";
    }
    var fillDeviation = psCfg.mode === 1 && q && Number(q.amountOut) > 0 ? Math.max(0, 1 - tokens / Number(q.amountOut)) : 0;
    if (fillDeviation > psCfg.slippage) {
        psState.risk.paused = true;
        psEvent("error", "实盘买入成交偏差 " + psR(fillDeviation * 100, 2) + "% 超过滑点容忍 " + psR(psCfg.slippage * 100, 2) + "%；已暂停后续新仓，请核实实际成交");
    }
    psState.buys.push(Date.now());
    psState.pos[w.mint] = {mint: w.mint, symbol: w.symbol, creator: w.creator, tokens: tokens, cost: cost, costLeft: cost, realized: 0,
        opened: Date.now(), peak: cost, tp1Done: false, lastValue: cost, pnlPct: 0, progress: w.progress, peakProg: w.progress, roundTrip: roundTrip, hist: [cost],
        curve: w.curve, flowHead: w.flowHead || null, entryFlow: w.flow || null, fillDeviationPct: psR(fillDeviation * 100, 2)};
    Log("✅ 买入", w.symbol, psShort(w.mint), "花费", psR(cost, 4), "SOL 得", psR(tokens, 0), "报价偏差", psR(fillDeviation * 100, 2) + "%", "|", psWatchCtx(w, Date.now()),
        "往返成本" + psR(roundTrip, 1) + "%", "|", w.flow ? psFlowText(w.flow) : "接力指标关闭", "|", tx, "#0000ff");
    psRecord({time: Date.now(), side: "buy", symbol: w.symbol, mint: w.mint, sol: cost, tx: tx});
    psSave(); // 先持久化成交及仓位，再释放订单锁
    if (psCfg.mode === 1) {
        psState.risk.reconcileRequired = false; psState.risk.pendingMint = "";
        psState.risk.pendingSide = ""; psState.risk.reconcileReason = ""; psState.pendingIntent = null;
        psSave();
    }
    return true;
}

function psSell(p, frac, why) {
    var all = frac >= 0.999, amount = all ? p.tokens : Math.floor(p.tokens * frac);
    if (!(amount > 0)) return null;
    var got, tx, soldTokens = amount;
    if (psCfg.mode === 1) {
        if (psState.risk.reconcileRequired || psState.risk.pendingMint) return null;
        psState.risk.reconcileRequired = true; psState.risk.pendingMint = p.mint; psState.risk.pendingSide = "sell";
        psState.risk.reconcileReason = "卖出提交中 " + p.symbol + " " + psShort(p.mint);
        psState.pendingIntent = {side: "sell", mint: p.mint, symbol: p.symbol, tokenAmount: amount, sellAll: all, positionTokens: p.tokens, costLeft: p.costLeft, started: Date.now()};
        psSave();
        // v3.3 P1-7：一律传数值。原版全平时传字符串 "all"，插件若按数值解析会变成 0/NaN → 卖不掉却记"结果未知"
        // 不在 options 里加自定义键（部分插件拒绝未知参数），amount 已是精确平仓量
        var r = psIO("pump.sell", p.mint, amount, {slippage: psCfg.slippage, priorityFee: psPrioFee(), wait: true});
        if (!r || r.pending || !(Number(r.solAmount) >= 0) || !(Number(r.tokenAmount) > 0)) {
            psState.risk.reconcileReason = "卖出结果未知 " + p.symbol + " " + psShort(p.mint) + (r && (r.txHash || r.signature) ? " tx=" + (r.txHash || r.signature) : "（无交易哈希）");
            psEvent("error", psState.risk.reconcileReason + "；暂停重复卖单与新仓，先核实链上状态并修复账本"); psSave(); return null;
        }
        got = Number(r.solAmount); soldTokens = Number(r.tokenAmount); tx = r.txHash || r.signature || "";
        if (!isFinite(soldTokens) || soldTokens > p.tokens * 1.001 || (!all && soldTokens > amount * 1.001)) {
            psState.risk.reconcileReason = "卖出成交数量超出账本/委托量 " + p.symbol + " actual=" + soldTokens + " order=" + amount;
            psEvent("error", psState.risk.reconcileReason + "；必须人工核对成交与余额"); psSave(); return null;
        }
    } else {
        if (psCfg.paperDelay > 0) Sleep(psCfg.paperDelay);
        var pq = psPaperQuote(p.mint, amount);
        if (pq) pq.got = Math.max(0, pq.got - psTxFee());
        if (!pq) { p.sellFail = (p.sellFail || 0) + 1; if (p.sellFail < 5) return null; pq = {got: 0, sold: amount}; why += "（报价连续失败，按 0 结算）"; }
        got = pq.got; soldTokens = Math.min(amount, pq.sold);
        tx = pq.sold >= amount ? "模拟" : "模拟(曲线储备只够卖 " + psR(pq.sold / amount * 100, 1) + "%，余量按 0)";
    }
    var beforeTokens = p.tokens;
    var costPart = p.costLeft * (all && soldTokens >= beforeTokens * 0.999 ? 1 : soldTokens / beforeTokens);
    var pnl = got - costPart;
    p.tokens = Math.max(0, p.tokens - soldTokens); p.costLeft = Math.max(0, p.costLeft - costPart); p.realized += got; p.lastWhy = why;
    psState.dayPnl += pnl; psState.totalPnl += pnl;
    Log("💰 卖出", p.symbol, psShort(p.mint), psR(soldTokens / beforeTokens * 100, 1) + "%", "得", psR(got, 4), "SOL 本段盈亏", psR(pnl, 4), "| 原因:", why, "|", psPosCtx(p, Date.now()), "|", tx, pnl >= 0 ? "#00a000" : "#ff0000");
    psRecord({time: Date.now(), side: "sell", symbol: p.symbol, mint: p.mint, sol: got, tokens: soldTokens, pnl: pnl, why: why, tx: tx});
    if (p.tokens <= Math.max(0.000001, beforeTokens * 0.000001)) {
        delete psState.pos[p.mint];
        psTryCloseAta(p.mint);                       // v3.3：卖完回收 ATA 租金
        var tot = p.realized - p.cost;
        Log("📕 平仓", p.symbol, psShort(p.mint), "收益率", psR(p.cost > 0 ? tot / p.cost * 100 : 0, 1) + "%", "盈亏", psR(tot, 4), "SOL 持有", psSec(Date.now() - p.opened),
            "止盈1", p.tp1Done ? "是" : "否", "最高浮盈", psR(p.maxPnl || 0, 1) + "%", "| 离场:", why, "| 入场时:", p.entryFlow ? psFlowText(p.entryFlow) : "-", tot >= 0 ? "#00a000" : "#ff0000");
        psAfterClose(p, tot); LogProfit(psR(psState.totalPnl, 6), "&");
    }
    psSave(); // 先落盘卖出回款和剩余仓位，再解除订单锁
    if (psCfg.mode === 1) {
        psState.risk.reconcileRequired = false; psState.risk.pendingMint = "";
        psState.risk.pendingSide = ""; psState.risk.reconcileReason = ""; psState.pendingIntent = null;
        psSave();
    }
    return got;
}

function psPaperQuote(mint, amount) {
    var q = psIO("pump.quote", mint, "sell", amount);
    if (q) return {got: Number(q.amountOut), sold: amount};
    var lo = 0, best = null, hi = amount;
    for (var i = 0; i < 12 && hi - lo > Math.max(1, amount * 0.002); i++) {
        var mid = Math.floor((lo + hi) / 2);
        var r = mid > 0 ? psIO("pump.quote", mint, "sell", mid) : null;
        if (r) { lo = mid; best = {got: Number(r.amountOut), sold: mid}; } else hi = mid;
    }
    if (best) return best;
    // 极小数量也报不出价：看曲线是否还有储备，没有则全部按 0；接口不可用返回 null
    var info = psIO("pump.info", mint);
    if (info && Number(info.realQuoteReserves) <= 0.000001) return {got: 0, sold: 0};
    return null;
}

// 曲线真实储备能付出的 SOL（扣 1% 手续费）；读不到返回 null
function psReserveCap(info) {
    if (!info || info.realQuoteReserves === null || info.realQuoteReserves === undefined) return null;
    var r = Number(info.realQuoteReserves);
    return isFinite(r) && r >= 0 ? r * 0.99 : null;
}

// 模拟报损：真实储备不超过 0.000001 SOL（1000 lamports），且曲线进度接近零。
// pump.info 的 realQuoteReserves 为可读 SOL 单位，不是 lamports。
function psPaperRugInfo(info) {
    if (!info || info.quote !== "SOL" || info.complete !== false || info.migrated !== false) return false;
    var reserve = info.realQuoteReserves, progress = info.progress;
    if (reserve === null || reserve === undefined || reserve === "" ||
        progress === null || progress === undefined || progress === "") return false;
    reserve = Number(reserve); progress = Number(progress);
    return isFinite(reserve) && reserve >= 0 && reserve <= 0.000001 &&
        isFinite(progress) && progress >= 0 && progress <= 0.01;
}

// 只结算模拟剩余成本，保留之前分批卖出所得；重复调用不重复记亏损。
function psPaperRugClose(p, info) {
    if (psCfg.mode !== 0 || !psPaperRugInfo(info) || psState.pos[p.mint] !== p) return false;
    if (!(isFinite(p.costLeft) && p.costLeft >= 0 && isFinite(p.realized) && isFinite(p.cost))) return false;
    if (psState.day !== psDay()) { psState.day = psDay(); psState.dayPnl = 0; }
    var loss = p.costLeft;
    var why = "模拟RUG报损：曲线储备枯竭，剩余仓位按零回收";
    p.tokens = 0; p.costLeft = 0; p.lastValue = 0; p.pnlPct = -100;
    p.progress = Number(info.progress); p.lastWhy = why;
    psState.dayPnl -= loss; psState.totalPnl -= loss;
    delete psState.pos[p.mint];
    psState.done[p.mint] = "模拟RUG已报损";
    psRecord({time: Date.now(), side: "sell", symbol: p.symbol, mint: p.mint,
        sol: 0, pnl: -loss, why: why, tx: "模拟报损（无链上交易）"});
    psAfterClose(p, p.realized - p.cost);
    psEvent("warning", why + " " + p.symbol + " " + psShort(p.mint) +
        "，储备 " + info.realQuoteReserves + " SOL，剩余成本损失 " + psR(loss, 6) + " SOL");
    psSave();
    LogProfit(psR(psState.totalPnl, 6), "&");
    return true;
}

/* ---------- 持仓管理 ---------- */
function psManage() {
    var now = Date.now();
    for (var m in psState.pos) {
        var p = psState.pos[m];
        var info = psIO("pump.info", m);
        // v3.3 P1-6：毕业后代币已在 PumpSwap，pump.sell 会持续失败 → 原版会被 maxHold 反复重试、
        // 永久占住 pMaxPos 名额（等于策略慢慢瘫痪）。改为连续 3 次失败后移入 orphan 名单并告警
        if (info && (info.complete || info.migrated)) {
            p.migrated = true;
            var mg = psSell(p, 1, "已毕业/迁移，尝试卖出");
            if (mg === null && psState.pos[m] && !psState.risk.reconcileRequired) {
                p.migFail = (p.migFail || 0) + 1;
                if (p.migFail >= 3) {
                    psState.orphans[p.mint] = {mint: m, symbol: p.symbol, tokens: p.tokens, cost: p.costLeft,
                        why: "毕业/迁移后 pump.sell 连续失败，代币在 PumpSwap，需人工卖出", t: Date.now()};
                    delete psState.pos[m];
                    psEvent("error", "⚠️ " + p.symbol + " 已迁移且卖不出去，移入 orphan 名单（不占持仓名额），请到 PumpSwap 手工卖出 " + psShort(m));
                    psSave();
                }
            }
            continue;
        }
        if (info && Number(info.progress) >= psCfg.exitProgress) { psSell(p, 1, "曲线即将毕业"); continue; }
        var q = psCfg.mode === 0 ? psPaperQuote(m, p.tokens) : psIO("pump.quote", m, "sell", p.tokens);   // 按真实可卖价值（含手续费与冲击）估值
        var value;
        if (q && psCfg.mode === 0) { p.quoteFail = q.sold < p.tokens ? 1 : 0; value = q.got; }
        else if (q) { p.quoteFail = 0; value = Number(q.amountOut); }
        else {
            // 报价失败本身不等于 RUG；须前后两次成功读到未毕业且储备枯竭。
            if (psCfg.mode === 0 && psPaperRugInfo(info)) {
                var freshInfo = psIO("pump.info", m);
                if (psPaperRugInfo(freshInfo)) { psPaperRugClose(p, freshInfo); continue; }
            }
            // 卖出量超过曲线真实储备时 pump.quote 报错：可卖价值上限就是储备（扣 1% 手续费）
            p.quoteFail = (p.quoteFail || 0) + 1;
            var cap = psReserveCap(info);
            if (cap === null) {   // 估值不了也要执行超时离场，psSell 内部有连续失败兜底
                if (now - p.opened > psCfg.maxHoldSec * 1000) psSell(p, 1, "持仓超时");
                continue;
            }
            value = cap;
        }
        var prev = p.lastValue;
        p.lastValue = value;
        if (info) { p.progress = Number(info.progress); p.peakProg = Math.max(p.peakProg || p.progress, p.progress); }
        p.hist.push(psR(value, 6)); if (p.hist.length > 60) p.hist.shift();
        p.pnlPct = p.costLeft > 0 ? (value / p.costLeft - 1) * 100 : 0;
        if (value > p.peak) p.peak = value;
        var dd = p.peak > 0 ? (1 - value / p.peak) * 100 : 0;
        if (prev > 0 && (1 - value / prev) * 100 >= psCfg.rugDrop) {
            psState.risk.banned[p.creator] = Date.now();
            psEvent("error", "疑似砸盘 " + p.symbol + "：单轮价值跌 " + psR((1 - value / prev) * 100, 1) + "%，紧急卖出并拉黑创建者 " + psShort(p.creator));
            psSell(p, 1, "砸盘紧急卖出");
            continue;
        }
        // 进度 = 曲线里的净买入 SOL；从高点明显回落说明资金在撤，比价格止损早（价格止损常被一根砸穿）
        if (psCfg.progDrop > 0 && p.peakProg - p.progress >= psCfg.progDrop) { psSell(p, 1, "进度回落 " + psR(p.peakProg, 1) + "%→" + psR(p.progress, 1) + "%"); continue; }
        if (psCfg.flowOn) {
            var fx = psFlowExit(p, now);
            if (fx) { psSell(p, 1, fx); continue; }
        }
        if (!p.tp1Done && p.pnlPct >= psCfg.tp1) {
            var beforeTpTokens = p.tokens; if (psSell(p, psCfg.tp1Pct / 100, "止盈1 +" + psR(p.pnlPct, 1) + "%") !== null && psState.pos[m]) { p.tp1Done = true; p.peak = value * p.tokens / beforeTpTokens; p.lastValue = p.peak; psSave(); }
            continue;
        }
        p.maxPnl = Math.max(p.maxPnl || 0, p.pnlPct);
        if (!p.tp1Done && psCfg.beAfter > 0 && p.maxPnl >= psCfg.beAfter && p.pnlPct <= 0) { psSell(p, 1, "保本离场"); continue; }
        if (p.pnlPct <= -psCfg.stopLoss) { psSell(p, 1, "止损 " + psR(p.pnlPct, 1) + "%"); continue; }
        if (p.tp1Done && dd >= psCfg.trail) { psSell(p, 1, "移动止损 回撤" + psR(dd, 1) + "%"); continue; }
        if (!p.tp1Done && psCfg.staleSec > 0 && now - p.opened > psCfg.staleSec * 1000 && p.pnlPct < psCfg.staleGain) { psSell(p, 1, "无动能离场 " + psR(p.pnlPct, 1) + "%"); continue; }
        if (now - p.opened > psCfg.maxHoldSec * 1000) { psSell(p, 1, "持仓超时"); continue; }
    }
}

// 实盘启动对账：本地有记录但钱包里已没有的仓位移除，数量以钱包为准
function psReconcile() {
    if (psCfg.mode !== 1) return true;
    var hs = psIO("pump.holdings");
    if (!Array.isArray(hs)) { psReconcileBlock = "pump.holdings 读取失败"; return false; }
    var have = {};
    hs.forEach(function(h) { if (h && h.mint && Number(h.amount) > 0) have[h.mint] = Number(h.amount); });
    var issues = [];
    for (var m in psState.pos) {
        if (!(have[m] > 0)) issues.push("账本有而钱包无 " + psState.pos[m].symbol + "(" + m + ")");
        else { var old = Number(psState.pos[m].tokens), actual = have[m]; if (Math.abs(actual - old) > Math.max(1, old * 0.005)) issues.push("数量不一致 " + psState.pos[m].symbol + " 账本=" + old + " 钱包=" + actual); else psState.pos[m].tokens = actual; }
        delete have[m];
    }
    Object.keys(have).forEach(function(m) { issues.push("钱包存在策略账本外代币 " + m + " 数量=" + have[m]); });
    psReconcileBlock = issues.length ? issues.join("；") : "";
    if (psReconcileBlock) psEvent("warning", "启动对账锁定新仓：" + psReconcileBlock);
    psSave(); return !psReconcileBlock;
}

/* ---------- 交互 ---------- */
function psCommand() {
    var cmd = GetCommand();
    if (!cmd) return;
    var parts = cmd.split(":");
    var rk = psState.risk;
    if (parts[0] === "pause") { rk.paused = true; psEvent("info", "已暂停新买入"); }
    else if (parts[0] === "resume") { rk.paused = false; psEvent("info", "已恢复买入"); }
    else if (parts[0] === "unhalt") {
        rk.halted = false; rk.haltReason = ""; rk.coolUntil = 0; rk.errUntil = 0; rk.streak = 0; rk.peak = psEquity();
        psEvent("info", "已解除停机/冷却/熔断，回撤基准重置为当前权益");
    }
    else if (parts[0] === "flatten") { for (var m in psState.pos) psSell(psState.pos[m], 1, "手动清仓"); }
    else if (parts[0] === "kill") {
        rk.halted = true; rk.haltReason = "手动紧急停机";
        for (var k in psState.pos) psSell(psState.pos[k], 1, "紧急停机清仓");
        psEvent("error", "紧急停机：已清仓并停止买入");
    }
    else if (parts[0] === "sell" && parts[1]) {
        var key = parts[1].trim().toLowerCase();
        for (var x in psState.pos) if (x.toLowerCase() === key || String(psState.pos[x].symbol).toLowerCase() === key) psSell(psState.pos[x], 1, "手动卖出");
    }
    else if (parts[0] === "shadowcsv") psShadowCsv();
    else if (parts[0] === "shadowreset") { psShadow = []; _G(psShadowKey(), psShadow); psEvent("info", "已清空影子样本"); }
    else if (parts[0] === "unban") { rk.banned = {}; psEvent("info", "已清空自动拉黑的创建者"); }
    else if (parts[0] === "ackreconcile") {
        if (rk.pendingMint) psEvent("error", "仍有结果未知的 " + rk.pendingSide + " " + rk.pendingMint + "；必须先在钱包/链上核实并修正账本，不能直接解锁");
        else if (psState.pendingIntent) psEvent("error", "仍有未核实的交易意图，保持锁定");
        else if (psCfg.mode === 1 && !psReconcile()) psEvent("error", "钱包与账本仍不一致，保持锁定");
        else { rk.reconcileRequired = false; rk.reconcileReason = ""; psEvent("warning", "人工确认完成对账，已解除新仓锁"); }
    }
}

/* ---------- 状态栏 ---------- */
function psStatus() {
    var now = Date.now();
    var rk = psState.risk;
    var block = psBlock();
    var eq = psEquity();
    var expo = psExposure();
    var dd = rk.peak > 0 ? Math.max(0, 1 - eq / rk.peak) : 0;
    var total = psState.wins + psState.losses;
    var unreal = 0;
    for (var m in psState.pos) unreal += psState.pos[m].lastValue - psState.pos[m].costLeft;
    var wallet = psCfg.mode === 1 ? psSolBalance() : null;

    var badges = {type: "badge", items: [
        {text: psCfg.mode === 1 ? "实盘" : "模拟", color: psCfg.mode === 1 ? "down" : "muted"},
        {text: rk.halted ? "已停机" : block ? "限制买入" : "允许买入", color: rk.halted ? "down" : block ? "warning" : "up"},
        {text: "持仓 " + Object.keys(psState.pos).length + "/" + psCfg.maxPos, color: "primary"},
        {text: "观察 " + Object.keys(psWatch).length, color: "muted"},
        {text: "orphan " + Object.keys(psState.orphans || {}).length, color: Object.keys(psState.orphans || {}).length ? "down" : "muted"}
    ]};
    var alert = rk.halted ? {type: "alert", level: "error", title: "已停机", text: rk.haltReason + "；点“解除停机”恢复"}
        : block ? {type: "alert", level: "warning", title: "暂不开新仓", text: block + "（持仓管理照常进行）"}
        : {type: "alert", level: "success", title: "运行正常", text: "单笔 " + psSize(false) + " SOL，本轮耗时 " + psR(psCycleMs / 1000, 1) + "s"};

    var kpis = {type: "grid", cols: 5, items: [
        {type: "kpi", id: "eq", title: "策略权益", value: psR(eq, 4), unit: "SOL", delta: psR(psState.totalPnl / psCfg.capital * 100, 2), hint: "本金 " + psCfg.capital},
        {type: "kpi", id: "day", title: "今日已实现", value: psR(psState.dayPnl, 4), unit: "SOL", color: psState.dayPnl >= 0 ? "up" : "down"},
        {type: "kpi", id: "unreal", title: "持仓浮盈", value: psR(unreal, 4), unit: "SOL", color: unreal >= 0 ? "up" : "down", hint: "敞口 " + psR(expo, 4)},
        {type: "kpi", id: "win", title: "胜率", value: total ? psState.wins / total : 0, format: {percent: true, precision: 1}, hint: psState.wins + " 胜 / " + psState.losses + " 负"},
        {type: "kpi", id: "wallet", title: psCfg.mode === 1 ? "钱包 SOL" : "运行时长", value: psCfg.mode === 1 ? psR(wallet, 4) : psR((now - psStart) / 3600000, 2), unit: psCfg.mode === 1 ? "SOL" : "小时",
            color: psCfg.mode === 1 && wallet !== null && wallet < psCfg.reserveSol * 2 ? "warning" : undefined}
    ]};

    var riskBars = {type: "grid", cols: 2, items: [
        {type: "gauge", id: "dd", title: "回撤 / 停机线 %", value: psR(dd * 100, 1), min: 0, max: psCfg.maxDrawdown,
            thresholds: [{value: 0, color: "up"}, {value: psCfg.maxDrawdown * 0.5, color: "warning"}, {value: psCfg.maxDrawdown * 0.8, color: "down"}]},
        {type: "grid", cols: 1, gap: "sm", items: [
            {type: "progress", id: "p-loss", title: "当日亏损额度", value: psR(Math.max(0, -psState.dayPnl), 4), max: psCfg.dailyLossSol, color: "down"},
            {type: "progress", id: "p-expo", title: "敞口占用", value: psR(expo, 4), max: psCfg.maxExposure, color: "warning"},
            {type: "progress", id: "p-pos", title: "持仓数", value: Object.keys(psState.pos).length, max: psCfg.maxPos, color: "primary"},
            {type: "progress", id: "p-buys", title: "近 1 小时买入", value: psState.buys.length, max: psCfg.maxBuysHour},
            {type: "progress", id: "p-streak", title: "连亏计数", value: rk.streak, max: psCfg.lossStreak, color: "down"}
        ]}
    ]};

    var posRows = Object.keys(psState.pos).map(function(k) {
        var p = psState.pos[k];
        return [p.symbol, psShort(k), psR(p.costLeft, 4), psR(p.lastValue, 4), p.pnlPct / 100, p.progress / 100,
            (p.tp1Done ? "已止盈1" : "-") + (p.quoteFail ? " · 超出储备部分按 0" : ""), Math.round((now - p.opened) / 1000), {type: "button", cmd: "sell:" + k, name: "卖出"}];
    });
    var watchRows = Object.keys(psWatch).map(function(k) {
        var w = psWatch[k];
        return [w.symbol, psShort(k), Math.round((now - w.seen) / 1000), w.progress === undefined ? null : w.progress / 100,
            w.rise === undefined ? null : w.rise / 100, psR(w.dev, 3), w.blocked || (now - w.seen < psCfg.observeSec * 1000 ? "观察中" : "待判定")];
    });
    var skip = {};
    for (var d in psState.done) { var r = psState.done[d]; skip[r] = (skip[r] || 0) + 1; }
    var skipKeys = Object.keys(skip).sort(function(a, b) { return skip[b] - skip[a]; });
    var closed = psState.closed;
    var dailyArr = Object.keys(psState.daily).sort().map(function(day) { return [psDayTs(day), psState.daily[day]]; });

    var tabs = {type: "tabs", id: "main-tabs", items: [
        {title: "持仓", items: [
            {type: "table", title: "当前持仓", cols: ["币", "Mint", {title: "剩余成本", unit: "SOL", align: "right"}, {title: "可卖价值", unit: "SOL", align: "right"},
                {title: "盈亏", format: {percent: true, precision: 1}, color: "sign", align: "right"}, {title: "曲线进度", format: {percent: true, precision: 1}, align: "right"},
                "止盈", {title: "持有", unit: "秒", align: "right"}, "操作"], rows: posRows},
            {type: "grid", cols: 3, items: Object.keys(psState.pos).slice(0, 6).map(function(k) {
                var p = psState.pos[k];
                return psPositionSparkline(k, p);
            })}
        ]},
        {title: "观察池", items: [
            {type: "table", title: "观察中的新币", cols: ["币", "Mint", {title: "已观察", unit: "秒", align: "right"}, {title: "进度", format: {percent: true, precision: 2}, align: "right"},
                {title: "近期涨幅", format: {percent: true, precision: 1}, color: "sign", align: "right"}, {title: "开发者首买", unit: "SOL", align: "right"}, "状态"], rows: watchRows}
        ]},
        {title: "筛选漏斗", cols: 2, items: [
            {type: "stat", id: "funnel", title: "本次运行漏斗", items: [
                {label: "发现新币", value: psFunnel.found}, {label: "静态过滤淘汰", value: psFunnel.filtered},
                {label: "观察期淘汰", value: psFunnel.rejected}, {label: "通过并下单", value: psFunnel.observed},
                {label: "成功买入", value: psFunnel.bought, color: "up"},
                {label: "通过率", value: psFunnel.found ? psFunnel.bought / psFunnel.found : 0, format: {percent: true, precision: 2}}]},
            {type: "pie", id: "skip-pie", title: "跳过原因（含历史）", items: skipKeys.slice(0, 8).map(function(k) { return {name: k, value: skip[k]}; })}
        ]},
        {title: "影子评估", cols: 2, items: psShadowPanel()},
        {title: "收益", cols: 3, items: [
            {type: "chart", id: "equity", span: 2, kind: "area", x: psState.equity.map(function(e) { return e[0]; }),
                series: [{name: "策略权益 SOL", data: psState.equity.map(function(e) { return e[1]; }), color: "up"}], height: 260},
            {type: "stat", id: "perf", title: "绩效", items: [
                {label: "累计已实现", value: psR(psState.totalPnl, 4), unit: "SOL", color: psState.totalPnl >= 0 ? "up" : "down"},
                {label: "收益率", value: psState.totalPnl / psCfg.capital, format: {percent: true, precision: 2}},
                {label: "最大回撤线", value: psCfg.maxDrawdown / 100, format: {percent: true, precision: 0}},
                {label: "平均单笔", value: closed.length ? closed.reduce(function(s, c) { return s + c.ret; }, 0) / closed.length : 0, format: {percent: true, precision: 1}},
                {label: "盈亏比", value: psProfitFactor(closed)},
                {label: "平仓笔数", value: closed.length}]},
            psReturnDistribution(closed),
            {type: "calendar", id: "cal", title: "每日已实现 SOL", data: dailyArr, format: {precision: 4}}
        ]},
        {title: "成交记录", cols: 3, items: [
            {type: "table", span: 2, title: "已平仓（最近 20 笔）", cols: ["币", "开仓", "平仓", {title: "成本", unit: "SOL", align: "right"}, {title: "收回", unit: "SOL", align: "right"},
                {title: "收益率", format: {percent: true, precision: 1}, color: "sign", align: "right"}, "离场原因"],
                rows: closed.slice(0, 20).map(function(c) { return [c.symbol, _D(c.opened).slice(5, 19), _D(c.closed).slice(5, 19), psR(c.cost, 4), psR(c.back, 4), c.ret, c.why || ""]; })},
            {type: "timeline", id: "trades", title: "最近成交", items: psState.trades.slice(0, 10).map(function(t) {
                return {time: t.time, text: (t.side === "buy" ? "买入 " : "卖出 ") + t.symbol + " " + psR(t.sol, 4) + " SOL" + (t.why ? " · " + t.why : ""), color: t.side === "buy" ? "primary" : (t.pnl >= 0 ? "up" : "down")};
            })}
        ]},
        {title: "风控", cols: 3, items: [
            {type: "table", span: 2, title: "风控规则", cols: ["规则", "当前", "阈值", "状态"], rows: [
                ["回撤停机", psR(dd * 100, 1) + "%", psCfg.maxDrawdown + "%", rk.halted ? "🔴 已停机" : "🟢"],
                ["当日亏损", psR(-psState.dayPnl, 4) + " SOL", psCfg.dailyLossSol + " SOL", psState.dayPnl <= -psCfg.dailyLossSol ? "🔴 今日停买" : "🟢"],
                ["连亏冷却", rk.streak + " 次", psCfg.lossStreak + " 次 / " + psCfg.coolMin + " 分", now < rk.coolUntil ? "🟡 冷却中" : "🟢"],
                ["接口熔断", psErrStreak + " 次", psCfg.maxErr + " 次 / " + psCfg.errPauseMin + " 分", now < rk.errUntil ? "🟡 熔断中" : "🟢"],
                ["数据延迟", psR(psCycleMs / 1000, 1) + "s", psCfg.maxLatency + "s", psCycleMs > psCfg.maxLatency * 1000 ? "🟡" : "🟢"],
                ["链上 RPC", "调用 " + psRpcStats.calls + " / 限流 " + psRpcStats.limited + " / 失败 " + psRpcStats.failed,
                    "等待 " + psR(psRpcStats.waitMs / 1000, 1) + "s", psRpcStats.failed ? "🟡" : "🟢"],
                ["持仓数", Object.keys(psState.pos).length, psCfg.maxPos, ""],
                ["总敞口", psR(expo, 4) + " SOL", psCfg.maxExposure + " SOL", ""],
                ["单笔仓位", psSize(false) + " SOL", "≤" + psCfg.buySol + " 且 ≤权益×" + psCfg.posPct + "%", ""],
                ["每小时买入", psState.buys.length, psCfg.maxBuysHour, ""],
                ["单笔止损 / 移动止损", "-", "-" + psCfg.stopLoss + "% / 回撤" + psCfg.trail + "%", ""],
                ["进度回落离场", "-", psCfg.progDrop + " 个百分点", ""],
                ["优先费", psR(psPrioFee(), 6) + " SOL", psCfg.dynFee ? "动态 " + psCfg.minPriorityFee + "~" + psCfg.priorityFee : "固定", ""],
                ["砸盘检测", "-", "单轮跌 " + psCfg.rugDrop + "%", ""],
                ["往返成本 / 价格冲击", "-", psCfg.maxRoundTrip + "% / " + psCfg.maxImpact + "%", ""],
                ["自动拉黑创建者", Object.keys(rk.banned).length + " 个", "", ""]
            ]},
            {type: "timeline", id: "events", title: "风控事件", items: psState.events.slice(0, 10).map(function(e) {
                return {time: e.time, text: e.text, color: e.level === "error" ? "down" : e.level === "warning" ? "warning" : "muted"};
            })}
        ]}
    ]};

    var buttons = {type: "table", title: "操作", cols: ["买入控制", "风控", "仓位", "名单"], rows: [[
        rk.paused ? {type: "button", cmd: "resume", name: "恢复买入"} : {type: "button", cmd: "pause", name: "暂停买入"},
        {type: "button", cmd: "unhalt", name: "解除停机/冷却/熔断"},
        {type: "button", cmd: "flatten", name: "全部清仓"},
        {type: "button", cmd: "unban", name: "清空自动拉黑"}
    ], [{type: "button", cmd: "kill", name: "紧急停机并清仓"}, {type: "button", cmd: "shadowcsv", name: "导出影子样本CSV"}, "", {type: "button", cmd: "shadowreset", name: "清空影子样本"}]]};

    LogStatus("🐶 Pump.fun 打金狗 · " + exchange.GetName() + " · 更新 " + _D(), badges, "\n", [alert, kpis, riskBars, tabs, buttons]);
}

function psShadowPanel() {
    var st = psShadowStats();
    var cols = ["分组", {title: "样本(10分)", align: "right"}, {title: "3分均值", format: {percent: true, precision: 1}, color: "sign", align: "right"},
        {title: "10分均值", format: {percent: true, precision: 1}, color: "sign", align: "right"}, {title: "30分均值", format: {percent: true, precision: 1}, color: "sign", align: "right"},
        {title: "10分胜率", format: {percent: true, precision: 0}, align: "right"}, {title: "10分最差", format: {percent: true, precision: 0}, color: "sign", align: "right"}, {title: "毕业", align: "right"}];
    return [
        {type: "table", title: "按评分（共 " + psShadow.length + " 个样本；毕业后报不出价不计入均值）", cols: cols, rows: st.byScore},
        {type: "table", title: "按当时的决定", cols: cols, rows: st.byDec},
        {type: "table", span: 2, title: "最近 20 个样本", cols: ["时间", "币", "决定", {title: "评分", align: "right"}, {title: "斜率", align: "right"}, {title: "净流入", align: "right"},
            {title: "买家", align: "right"}, {title: "前10%", align: "right"}, {title: "抢筹%", align: "right"}, {title: "进度%", align: "right"},
            {title: "3分", format: {percent: true, precision: 1}, color: "sign", align: "right"}, {title: "10分", format: {percent: true, precision: 1}, color: "sign", align: "right"},
            {title: "30分", format: {percent: true, precision: 1}, color: "sign", align: "right"}],
            rows: psShadow.slice(0, 20).map(function(x) {
                var f = function(h) { return x.r[h] === undefined ? "…" : x.r[h] === null ? (x.grad ? "毕业" : "-") : x.r[h]; };
                return [_D(x.t).slice(5, 19), x.sym, x.dec, x.score, x.slope, x.net, x.uniq, x.top10, x.sniper === null ? "-" : x.sniper, x.prog, f(180), f(600), f(1800)];
            })}
    ];
}

// sparkline 至少需要两个有效数字；新仓仅有一个点时先显示数值卡。
function psPositionSparkline(mint, p) {
    var data = (Array.isArray(p.hist) ? p.hist : []).filter(function(v) {
        return typeof v === "number" && isFinite(v);
    });
    if (data.length < 2) {
        var value = data.length ? data[0] : p.lastValue;
        if (typeof value !== "number" || !isFinite(value)) value = "--";
        return {type: "kpi", id: "sp-pending-" + mint, title: p.symbol + " 可卖价值",
            value: value, unit: "SOL", format: {precision: 6}, hint: "等待至少 2 个有效采样点后显示走势"};
    }
    return {type: "sparkline", id: "sp-" + mint, title: p.symbol + " 可卖价值",
        data: data, unit: "SOL"};
}

// histogram 至少需要 2 个有效数字；不补零，以免扭曲收益分布。
function psReturnDistribution(closed) {
    var returns = closed.map(function(c) { return c.ret; }).filter(function(ret) {
        return typeof ret === "number" && isFinite(ret);
    });
    if (returns.length < 2) {
        return {type: "alert", id: "ret-dist-empty", title: "单笔收益分布", span: 2,
            level: "info", text: "有效平仓收益样本 " + returns.length + " 笔，至少需要 2 笔后显示收益分布。"};
    }
    return {type: "histogram", id: "ret-dist", title: "单笔收益分布", span: 2,
        data: returns, format: {percent: true, precision: 0}};
}

function psProfitFactor(closed) {
    var win = 0, loss = 0;
    closed.forEach(function(c) { var v = c.back - c.cost; if (v >= 0) win += v; else loss -= v; });
    return loss > 0 ? psR(win / loss, 2) : (win > 0 ? "∞" : "-");
}

function psTrimDone() {
    var keys = Object.keys(psState.done);
    if (keys.length > 3000) keys.slice(0, keys.length - 2000).forEach(function(k) { delete psState.done[k]; });
}

function main() {
    if (IsVirtual()) throw new Error("本策略依赖链上实时数据，不支持回测");
    psCfg = psCfgLoad();
    if (typeof exchanges === "undefined" || exchanges.length !== 1) throw new Error("本策略必须且只能配置 1 个交易所对象：Jupiter");
    if (exchange.GetName() !== "Jupiter") throw new Error("交易所配置错误：请将唯一交易所对象设为 Jupiter");
    var pair = ""; try { pair = exchange.GetCurrency(); } catch (e) {}
    if (psCfg.mode === 1 && (!pair || String(pair).split("_")[0] !== "SOL")) throw new Error("Pump.fun 实盘报价币为 SOL，交易对请设为 SOL_USDC 等 SOL_*，当前为 " + pair);
    if (psCfg.mode === 1) {
        var initialSol = psSolBalance();
        var requiredSol = psCfg.reserveSol + psCfg.minBuySol + psCfg.priorityFee + psEntryBufferSol;
        if (initialSol === null) throw new Error("启动失败：无法读取 SOL 余额");
        if (initialSol < requiredSol) throw new Error("启动失败：SOL 余额 " + psR(initialSol, 6) + " 小于最低所需 " + psR(requiredSol, 6));
    }
    // 模拟：每次启动清空存档、日志和收益曲线；实盘保留，避免钱包里的仓位丢失本地记录
    // 影子样本跨重启保留（需要攒很多天的数据），清空前先取出
    var keepShadow = _G(psShadowKey());
    if (psCfg.mode === 0) { _G(psStateKey(), null); LogReset(); LogProfitReset(); }
    psShadow = Array.isArray(keepShadow) ? keepShadow : [];
    _G(psShadowKey(), psShadow);
    SetErrorFilter("curve's real reserves");   // 储备不足的报价错误已由策略处理，不再每轮刷日志
    psLoad();
    psCreatorLoad();
    psReconcile();
    if (psCfg.mode === 1) {
        var rpcCfg = ""; try { rpcCfg = String(exchange.IO("base") || ""); } catch (e) {}
        if (psCfg.flowOn && !rpcCfg.trim()) psPreflightBlock = "未配置 Solana RPC 节点，接力指标无法读取";
        
        if (psPreflightBlock) psEvent("warning", "资金预检阻断新仓：" + psPreflightBlock);
    }
    psEvent("info", "打金狗启动，模式 " + (psCfg.mode === 1 ? "实盘" : "模拟") + "，资金 " + psCfg.capital + " SOL，单笔上限 " + psCfg.buySol + " SOL");
    var lastStatus = 0;
    while (true) {
        var t0 = Date.now();
        psFlowMs = 0;
        try {
            psCommand();
            psManage();          // 先管仓位，卖出优先
            psDiscover();
            psManage();          // 发现新币较慢，再查一次持仓，缩短砸盘反应时间
            psEvaluate();
            psShadowTick();
            psTrimDone();
            psFilterSummary();
            psSave();
        } catch (e) {
            Log("循环异常:", e.message || e);
        }
        // v3.3 P0修复：链上成交解析耗时不算"行情新鲜度"。原版把 psFlowMs 也计进来，
        // 开 2~3 个仓后一轮就 >15s，pMaxLatency 闸门永久触发 → 全市场停买（日志只会说"数据延迟"）
        psCycleMs = Date.now() - t0 - psFlowMs;
        if (Date.now() - lastStatus > 3000) {
            try { psStatus(); } catch (e2) { Log("状态栏异常:", e2.message || e2); }
            lastStatus = Date.now();
        }
        Sleep(psCfg.interval * 1000);
    }
}