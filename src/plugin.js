/* 思源子文档编号插件 · 插件主体 v0.6.0
 * 触发：
 *   1. 文档树右键 →「给子文档编号」/「撤销上次编号」（手动，v0.1.0 保留）
 *   2. 文档树右键 →「设为自动编号范围 / 取消」（文档或整个笔记本）
 *   3. 范围内发生 新建 / 删除 / 拖动位置 / 改名 → ws-main 结构事件 → 防抖 → 自动重排
 * 实测依据：probe/改名API实测.md、probe/文档树顺序实测.md、probe/自动触发事件实测.md（思源 3.8.9）
 *   1. 改标题只用 /api/filetree/renameDocByID {id,title}：不换文档 ID、不动 path、不动正文块 ID
 *   2. updateBlock 打文档块会删光正文 → 绝不调用
 *   3. 同级顺序 = listDocsByPath 的 files 数组（文档树自定义排序）；叶子用 subFileCount 判掉，不能调接口
 *   4. 新建/删除/拖动会广播 create / removeDoc / filetreeSortChanged；后者自带新顺序 childIDs
 *   5. 每个 ws 事件广播两次，且插件自己改名会广播 rename → 必须防抖 + 结构指纹 + 幂等
 */
const {Plugin, showMessage, Dialog} = require("siyuan");
const DN = globalThis.DocNumbering;
const BN = globalThis.BodyNumbering;

/* 版本号唯一来源：build.py 会拿它和 plugin.json 的 version 比对，不一致直接报错。 */
const PLUGIN_VERSION = "1.2.3";

const UNDO_FILE = "undo-last.json";
const BODY_UNDO_FILE = "body-undo-last.json";
const CONFIG_FILE = "auto-config.json";
const MENU_ICON = "iconOrderedList";
const ID_RE = /^[0-9a-z-]{10,}$/i;
const DEFAULT_CONFIG = {
    enabled: true,
    debounceMs: 1500,
    skipUntitled: true,
    notify: false,
    targets: [],          // [{type:"doc"|"notebook", id, box?, name, formats?, lastFormats?}]
    excluded: [],         // [{id, name, mode:"self"|"subtree"}] 不参与编号的文档
    // 新范围 / 手动右键用的默认设置；每个 target 可用自己的 formats/counters/maxLevel 覆盖
    // v0.4.0 用户指定：1【title】/【1】title/第1部/第1章/第1.1节；v0.7.2 起第 3 级默认改「第1篇」
    defaultFormats: {
        1: "{n}【{title}】", 2: "【{n}】{title}", 3: "第{n}篇{title}",
        4: "第{n}章 {title}", 5: "第{parentN}.{n}节 {title}",
    },
    // 1 全书连续；2/3/5 按上一级重排；4 按上上级重排（跨部连号、换【n】才回 1）
    defaultCounters: {1: "global", 2: "local", 3: "local", 4: "grandlocal", 5: "local"},
    defaultMaxLevel: 5,       // 可增减到 1~5 级
    lastDefaultFormats: null, // 上次用过的全局默认模板，换格式时用来剥旧号
    defaultsVersion: 2,       // 一次性迁移标记：v0.3 旧默认 → v0.4 新默认
    // 正文标题编号（v0.5.0）：快捷键 Ctrl+Alt+1..5；模板缺省用 BN.BUILTIN_BODY_FORMATS
    bodyEnabled: true,        // 快捷键开关（面板「正文标题编号」区）
    bodyAuto: false,         // v0.6.0 正文自动编号：savedoc 触发 + 防抖，默认关，面板里开
    bodyFormats: null,        // null = 内置默认；自定义后为 {1..5}
    bodyLastFormats: null,    // 上次用过的正文模板，换模板时剥旧号兜底
};
/* v0.3 内置默认，只用来判断「用户从没自定义过默认设置」。
 * 用户改过任一项就一律不迁移，避免把他调好的格式冲掉。 */
const LEGACY_V3 = {
    formats: {
        1: "第{nn}部 {title}", 2: "第{nn}章 {title}", 3: "第{nn}节 {title}",
        4: "第{nn}条 {title}", 5: "第{nn}款 {title}",
    },
    counters: {1: "global", 2: "global", 3: "local", 4: "local", 5: "local"},
    maxLevel: 3,
};
const DEFAULT_SCOPE = "__default__";
const MAX_DEPTH = 8;
const MAX_NODES = 2000;
const SORT_ORDER_TTL = 60000;   // filetreeSortChanged 带来的新顺序，60s 内优先采用

/* v0.8.7 性能/稳定性常量（改前实测见 基线报告.md）：
 *   - DIR_CONCURRENCY：157 个目录串行读 ≈1.1s，改有限并发；不用无限并发，避免压垮内核
 *   - DIR_RETRY / NUMMAP_RETRY：目录与属性读取偶发失败时重试，仍失败则整轮跳过、不写库
 *   - VERIFY_ROUNDS：改名后回读校验最多 4 轮（原 8 轮，索引滞后一般 <1s 就收敛）
 *   - AUTO_PENDING_MAX：忙时补跑最多连续 3 轮，避免异常情况下无限自旋 */
const DIR_CONCURRENCY = 6;
const DIR_RETRY = 1;
const NUMMAP_RETRY = 2;
const VERIFY_ROUNDS = 4;
const AUTO_PENDING_MAX = 3;

/* 顶栏面板样式：只负责布局与留白，颜色一律取思源主题变量，亮 / 暗主题自动跟随。
 * 结构对齐思源原生对话框：.b3-dialog__content（滚动区）+ .b3-dialog__action（底部固定条）。
 * 类名统一 dn- 前缀，避免污染宿主界面。 */
const PANEL_CSS = `
.dn-root{padding:18px 22px 24px;font-size:14px;color:var(--b3-theme-on-background)}
.dn-root *{box-sizing:border-box}
.dn-hero{display:flex;align-items:center;gap:14px;padding:14px 17px;margin-bottom:14px;
  background:var(--b3-theme-primary-lightest);border:1px solid var(--b3-theme-primary-lighter);
  border-radius:var(--b3-border-radius,6px)}
.dn-hero__icon{width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;
  border-radius:10px;background:var(--b3-theme-primary);color:#fff}
.dn-hero__icon svg{width:20px;height:20px;display:block}
.dn-hero__body{flex:1;min-width:0}
.dn-hero__title{font-size:15px;font-weight:600;letter-spacing:.2px}
.dn-hero__desc{font-size:12px;color:var(--b3-theme-on-surface);margin-top:3px}
.dn-hero .b3-switch{flex:none}
.dn-hero--off{background:var(--b3-theme-surface);border-color:var(--b3-border-color)}
.dn-hero--off .dn-hero__icon{background:var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface)}
.dn-opt{display:flex;align-items:center;gap:12px;padding:9px 13px;margin-bottom:18px;
  background:var(--b3-theme-surface);border:1px solid var(--b3-border-color);
  border-radius:var(--b3-border-radius,6px)}
.dn-opt__body{flex:1;min-width:0}
.dn-opt__title{font-size:13px}
.dn-opt__desc{font-size:11px;color:var(--b3-theme-on-surface);margin-top:2px;line-height:1.5}
.dn-sec{margin-bottom:18px}
.dn-sec__head{display:flex;align-items:baseline;gap:9px;margin:0 0 10px}
.dn-sec__title{font-size:14px;font-weight:600;white-space:nowrap}
.dn-sec__desc{font-size:11px;color:var(--b3-theme-on-surface)}
.dn-count{min-width:20px;height:18px;padding:0 6px;border-radius:9px;display:inline-flex;
  align-items:center;justify-content:center;font-size:11px;
  background:var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface)}
.dn-toolbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:11px}
.dn-field{display:flex;align-items:center;gap:8px}
.dn-field--scope{flex:1;min-width:230px}
.dn-field__label{font-size:12px;color:var(--b3-theme-on-surface);white-space:nowrap}
.dn-field--scope .b3-select{flex:1;min-width:0}
.dn-stepper{display:flex;align-items:center;gap:2px;padding:2px;background:var(--b3-theme-surface);
  border:1px solid var(--b3-border-color);border-radius:var(--b3-border-radius,6px)}
.dn-step{width:22px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;
  padding:0;border:0;border-radius:4px;background:transparent;cursor:pointer;
  color:var(--b3-theme-on-surface);font-size:16px;line-height:1}
.dn-step:hover{background:var(--b3-theme-primary-lightest);color:var(--b3-theme-primary)}
#dn-maxlevel{min-width:22px;text-align:center;font-weight:600;font-variant-numeric:tabular-nums}
.dn-table{border:1px solid var(--b3-border-color);border-radius:var(--b3-border-radius,6px);overflow:hidden}
.dn-table__head,.dn-table__row{display:flex;align-items:center;gap:10px;padding:6px 12px}
.dn-table__head{background:var(--b3-theme-surface);color:var(--b3-theme-on-surface);font-size:11px;
  border-bottom:1px solid var(--b3-border-color)}
.dn-table__head span:nth-child(1){width:78px;flex:none}
.dn-table__head span:nth-child(2){flex:1}
.dn-table__head span:nth-child(3){width:124px;flex:none}
.dn-table__head span:nth-child(4){width:24px;flex:none}
.dn-lvdel{width:24px;height:24px;flex:none}
.dn-lvdel:disabled{opacity:.3;cursor:not-allowed}
.dn-lvdel:disabled:hover{background:transparent;color:var(--b3-theme-on-surface)}
.dn-table__row{border-bottom:1px solid var(--b3-theme-surface-lighter)}
.dn-table__row:last-child{border-bottom:0}
.dn-table__row:hover{background:var(--b3-theme-surface-light)}
/* 分组条：把「文档标题 1~5 级」与「内容标题 1~5 级」放进同一张表，但一眼能分出两组 */
.dn-group{display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:11px;font-weight:600;
  letter-spacing:.3px;color:var(--b3-theme-on-background);
  background:var(--b3-theme-surface-lighter);border-top:1px solid var(--b3-border-color)}
.dn-table__head + .dn-group{border-top:0}
.dn-group__dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--b3-theme-primary)}
.dn-group__dot--body{background:var(--b3-theme-on-surface);opacity:.55}
.dn-group__hint{font-weight:400;font-size:11px;color:var(--b3-theme-on-surface);margin-left:auto}
.dn-cells{width:124px;flex:none;font-size:12px;color:var(--b3-theme-on-surface)}
.dn-cells--tail{width:24px}
.dn-cells--muted{opacity:.6;padding-left:10px}
.dn-lv__num--body{background:var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface)}
.dn-opt--tight{padding:8px 12px;margin-bottom:8px}
.dn-pv__cap{margin:8px 0 3px;font-size:11px;font-weight:600;letter-spacing:.4px;
  color:var(--b3-theme-on-surface);opacity:.85}
.dn-pv__cap--sep{padding-top:8px;border-top:1px dashed var(--b3-border-color)}
.dn-lv{width:78px;flex:none;display:flex;align-items:center;gap:7px;font-size:12px;
  color:var(--b3-theme-on-surface);white-space:nowrap}
.dn-lv__num{width:18px;height:18px;flex:none;display:flex;align-items:center;justify-content:center;
  border-radius:5px;background:var(--b3-theme-primary-lightest);color:var(--b3-theme-primary);
  font-size:11px;font-weight:600}
.dn-table__row .b3-text-field{flex:1;min-width:0;font-size:13px}
.dn-table__row .b3-select{width:124px;flex:none;font-size:12px}
.dn-legend{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:9px 0 10px}
.dn-tag{padding:2px 8px;border-radius:4px;font-size:11px;
  background:var(--b3-theme-surface);border:1px solid var(--b3-border-color);
  color:var(--b3-theme-on-surface)}
.dn-tag--fmt{background:var(--b3-theme-primary-lightest);border-color:var(--b3-theme-primary-lighter)}
.dn-tag code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  color:var(--b3-theme-primary);font-size:11px}
.dn-legend__hint{flex-basis:100%;margin-top:2px;font-size:11px;line-height:1.6;
  color:var(--b3-theme-on-surface);opacity:.9}
.dn-preview{padding:9px 12px;margin-bottom:10px;background:var(--b3-theme-surface);
  border:1px solid var(--b3-border-color);border-radius:var(--b3-border-radius,6px)}
.dn-preview__label{margin-bottom:6px;font-size:11px;font-weight:600;letter-spacing:.5px;
  color:var(--b3-theme-on-surface)}
#dn-preview,#dn-bpreview{font-size:12px;line-height:1.8}
#dn-preview>div,#dn-bpreview>div{display:flex;align-items:baseline;gap:10px;padding:1px 0}
.dn-pv__lv{width:88px;flex:none;color:var(--b3-theme-on-surface)}
#dn-preview b,#dn-bpreview b{font-weight:500;color:var(--b3-theme-primary);
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dn-sec__actions{display:flex;justify-content:flex-end;gap:8px}
.dn-a-left{margin-right:auto}
.dn-list{max-height:210px;overflow-y:auto;border:1px solid var(--b3-border-color);
  border-radius:var(--b3-border-radius,6px)}
.dn-item{display:flex;align-items:center;gap:10px;padding:8px 12px;
  border-bottom:1px solid var(--b3-theme-surface-lighter)}
.dn-item:last-child{border-bottom:0}
.dn-item:hover{background:var(--b3-theme-surface-light)}
.dn-item__icon{width:16px;height:16px;flex:none;color:var(--b3-theme-primary);opacity:.8}
.dn-item__icon svg,.dn-empty svg,.dn-remove svg{width:100%;height:100%;display:block}
.dn-item__body{flex:1;min-width:0}
.dn-item__name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dn-item__meta{margin-top:2px;font-size:11px;color:var(--b3-theme-on-surface);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dn-item__badge{flex:none;padding:1px 7px;border-radius:3px;font-size:10px;
  background:var(--b3-theme-surface-lighter);color:var(--b3-theme-on-surface)}
.dn-remove{width:24px;height:24px;flex:none;padding:4px;border:0;border-radius:4px;
  background:transparent;cursor:pointer;color:var(--b3-theme-on-surface);
  display:flex;align-items:center;justify-content:center}
.dn-remove:hover{background:var(--b3-theme-error);color:#fff}
.dn-empty{display:flex;align-items:center;gap:8px;padding:13px 12px;font-size:12px;
  color:var(--b3-theme-on-surface);border:1px dashed var(--b3-border-color);
  border-radius:var(--b3-border-radius,6px)}
.dn-empty svg{width:14px;height:14px;flex:none}
.dn-empty b{font-weight:500;color:var(--b3-theme-on-background)}
.dn-foot{padding-top:10px;border-top:1px solid var(--b3-theme-surface-lighter);
  font-size:11px;line-height:1.7;color:var(--b3-theme-on-surface)}
.dn-actions{justify-content:space-between}
.dn-actions__left,.dn-actions__right{display:flex;align-items:center;gap:8px}
`;

/* 线性图标：与思源自带图标同一风格，颜色取 currentColor，不写死颜色、不用 emoji。 */
const PANEL_ICONS = {
    list: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M9 6h11M9 12h11M9 18h11'/><path d='M4 5.5h1.1v3'/><path d='M3.7 8.5h1.7'/><path d='M3.7 14.2h1.8l-1.8 3h1.9'/></svg>",
    doc: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><path d='M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z'/><path d='M14 3v6h6'/></svg>",
    notebook: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'><rect x='4' y='3' width='16' height='18' rx='2'/><path d='M8 3v18M12 8h5M12 12h5'/></svg>",
    remove: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><path d='M18 6 6 18M6 6l12 12'/></svg>",
    info: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round'><circle cx='12' cy='12' r='9'/><path d='M12 11v5M12 8h.01'/></svg>",
};

function esc(s) {
    return String(s == null ? "" : s).replace(/'/g, "''");
}

function escHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* v0.7.5：请求必须带超时。审查发现老实现用裸 fetch —— 内核卡住或代理拦掉时 Promise 永不落地，
 * _bodyBusy 会被永久钉在 true，自动编号从此静默失效（重启插件才恢复）。
 * 20s 足够「91 篇批量」里任何单次调用，又不至于让用户等太久。 */
const API_TIMEOUT_MS = 20000;

async function api(path, payload) {
    const ctl = (typeof AbortController === "function") ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, API_TIMEOUT_MS) : null;
    let res;
    try {
        res = await fetch(path, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload || {}),
            signal: ctl ? ctl.signal : undefined,
        });
    } catch (e) {
        if (e && e.name === "AbortError") throw new Error(path + "：请求超时（" + API_TIMEOUT_MS + "ms）");
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
    }
    const j = await res.json();
    if (j.code !== 0) throw new Error(path + "：" + (j.msg || ("code " + j.code)));
    return j.data;
}

function sql(stmt) {
    return api("/api/query/sql", {stmt});
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** getBlockKramdown 会在末尾附 `{: id="…" updated="…"}` 属性行，写回 updateBlock 前必须去掉。
 *  实测：SQL 的 content/markdown 有索引滞后，只有 getBlockKramdown 是实时的（见探针报告）。 */
function cleanKramdown(kd) {
    return String(kd || "").split("\n")
        .filter((l) => !/^\s*\{:\s*id=/.test(l))
        .join("\n").replace(/\s+$/, "");
}

function targetKey(t) {
    return (t.type || "doc") + ":" + t.id;
}

/** 有上限的并发 map：结果按输入下标归位，不依赖响应到达顺序。 */
async function mapLimit(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const n = Math.max(1, Math.min(limit || 1, items.length || 1));
    async function runner() {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            out[i] = await worker(items[i], i);
        }
    }
    const runners = [];
    for (let i = 0; i < n; i++) runners.push(runner());
    await Promise.all(runners);
    return out;
}

/** 结构事件 → 受影响的 targetKey 列表；返回 null = 判不准，必须全量检查。
 *  payload 依据 probe/自动触发事件实测.md（思源 3.8.9）：
 *    create               {box:{id}, path}
 *    rename               {box:"<boxId>", id, path}
 *    filetreeSortChanged  {notebook:"<boxId>", parentPath, childIDs}
 *    removeDoc            {ids:[...]}  ← 无 box，判不准 → 全量
 *  文档范围若没存 box，一律保守纳入（宁可多查一个小范围，不可漏编）。 */
function keysForEvent(cfg, cmd, d) {
    const data = d || {};
    let box = "";
    if (cmd === "filetreeSortChanged") box = String(data.notebook || "");
    else if (cmd === "create") box = String((data.box && data.box.id) || "");
    else if (cmd === "rename") box = typeof data.box === "string"
        ? data.box : String((data.box && data.box.id) || "");
    else return null;
    if (!box) return null;
    const path = String(data.path || data.parentPath || "");
    const out = [];
    (cfg.targets || []).forEach((t) => {
        if (!t || !t.id) return;
        if (t.type === "notebook") {
            if (t.id === box) out.push(targetKey(t));
        } else if (!t.box || t.box === box || (t.id && path.indexOf(t.id) >= 0)) {
            out.push(targetKey(t));
        }
    });
    return out;   // 空数组 = 事件与所有范围无关，整轮可跳过
}

/** 文档 ID 路径 → 目录段（去掉结尾 .sy）。
 *  ⚠️ 2026-11-07 审查发现：rangeDocIds 的 subtree 排除分支用了它，但当时只在 idsForTarget 内部
 *  局部定义过 → 那里抛 ReferenceError 被 catch 吞掉，导致「排除整支」静默失效。一律用这个模块级版本。 */
function subOf(p) {
    const b = String(p || "");
    return b.slice(-3) === ".sy" ? b.slice(0, -3) : b;
}

/**
 * 重叠范围归属：一篇文档若同时被「文档范围」和更大的范围（整个笔记本 / 父文档）覆盖，
 * 它那棵子树的编号归更具体的文档范围管；外层范围只编号到该文档节点本身，不再下钻。
 * 否则同一批文档会按两套层级口径轮流改写（真机表现：文档树标题不停闪烁）。
 */
function ownedDocIds(cfg, target) {
    const key = targetKey(target);
    return (Array.isArray(cfg.targets) ? cfg.targets : [])
        .filter((x) => x && x.type === "doc" && x.id && targetKey(x) !== key)
        .map((x) => x.id);
}

function registeredTarget(cfg, target) {
    const key = targetKey(target);
    return (cfg.targets || []).find((t) => targetKey(t) === key) || null;
}

/** 一个范围的完整编号设置：层级数 + 各级模板 + 各级计数方式。 */
function scopeSpec(cfg, scope) {
    const t = scope === DEFAULT_SCOPE
        ? null : (cfg.targets || []).find((x) => targetKey(x) === scope);
    return {
        maxLevel: DN.clampLevel(t && t.maxLevel != null ? t.maxLevel : cfg.defaultMaxLevel),
        formats: DN.normalizeFormats(t && t.formats ? t.formats : cfg.defaultFormats,
                                    DN.BUILTIN_V4_FORMATS),
        counters: DN.normalizeCounters(t && t.counters ? t.counters : cfg.defaultCounters),
    };
}

function specForTarget(cfg, target) {
    return scopeSpec(cfg, targetKey(target));
}

function formatsFor(cfg, target) {
    return specForTarget(cfg, target).formats;
}

/** 换格式时能剥掉旧前缀的模板清单：当前 + 上次（范围级 / 全局级） + 全局默认
 *  （内置默认由核心恒定追加）。继承全局默认的范围必须也带上「上次全局默认」，
 *  否则改默认模板再改回去会留下「第01部 卷01 xxx」这种双前缀。 */
function stripListFor(cfg, target) {
    const t = registeredTarget(cfg, target);
    const list = [formatsFor(cfg, target)];
    if (t && t.lastFormats) list.push(DN.normalizeFormats(t.lastFormats));
    /* v0.8.2：各范围保留多份历史模板。只记「上一次」时，连换两次就把更早那套忘了，
     * 老号再也剥不掉（用户报「切换编号，老编号没剔除」）。 */
    (Array.isArray(t && t.formatsHistory) ? t.formatsHistory : []).forEach((f) => {
        list.push(DN.normalizeFormats(f));
    });
    if ((!t || !t.formats) && cfg.lastDefaultFormats) {
        list.push(DN.normalizeFormats(cfg.lastDefaultFormats));
    }
    (Array.isArray(cfg.defaultFormatsHistory) ? cfg.defaultFormatsHistory : []).forEach((f) => {
        list.push(DN.normalizeFormats(f));
    });
    list.push(DN.normalizeFormats(cfg.defaultFormats, DN.BUILTIN_V4_FORMATS));
    return list;
}

/** 正文编号的剥号清单：当前 + 上一次 + 全部历史 + 内置默认。
 *  切换正文编号方案时，老号（`[1] `、`(1) `、`（1）`…）必须在这之前就剔干净。 */
function bodyStripList(cfg, cur) {
    const list = [cur || (cfg.bodyFormats ? BN.normalizeBodyFormats(cfg.bodyFormats)
                                         : BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS))];
    if (cfg.bodyLastFormats) list.push(BN.normalizeBodyFormats(cfg.bodyLastFormats));
    (Array.isArray(cfg.bodyFormatsHistory) ? cfg.bodyFormatsHistory : []).forEach((f) => {
        list.push(BN.normalizeBodyFormats(f));
    });
    list.push(BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS));
    return list;
}

/** 合法占位符白名单：tree / 内容两侧共用（`:格式` 后缀不参与校验）。
 *  v0.8.4：用户把内容 1 级写成 `{fh3}.{fn4}.{n}`（`fh3` 是 `fn3` 的笔误），插件不认这个名字、
 *  原样写进标题 → `1.1 {fh3}..1 {fh3}..1 土壤…`（107 篇 510 条）。现在保存前直接拦下。 */
const PH_OK = /^(title|prefix|h1|cn|n|nn|parentN|parentNN|fn[1-5]|hn[1-5]|fn|hn)(:[^}]*)?$/;

/** 返回模板里不认识的占位符名字（去重）。空数组 = 全部合法。 */
function badPlaceholders(formats) {
    const bad = new Set();
    Object.keys(formats || {}).forEach((lv) => {
        const tpl = String(formats[lv] == null ? "" : formats[lv]);
        const re = /\{([^{}]{1,24})\}/g;
        let m;
        while ((m = re.exec(tpl)) !== null) {
            if (!PH_OK.test(m[1])) bad.add("{" + m[1] + "}");
        }
    });
    return Array.from(bad);
}

/** 把「上一套模板」推进历史（去重、封顶 8 份）。切换编号前，历史里的每一套都会参与剥号。 */
function pushFormatsHistory(list, formats) {
    const arr = Array.isArray(list) ? list.slice() : [];
    if (!formats) return arr;
    const norm = DN.normalizeFormats(formats);
    const sig = JSON.stringify(norm);
    if (!arr.some((f) => JSON.stringify(DN.normalizeFormats(f)) === sig)) arr.push(norm);
    return arr.slice(-8);
}

/** 面板下拉里某一项的三级模板（同步读内存配置，供 UI 即时填充）。 */
function scopeFormats(cfg, scope) {
    return scopeSpec(cfg, scope).formats;
}

module.exports = class DocNumberPlugin extends Plugin {

    onload() {
        this._fp = {};                       // targetKey -> 上次结构指纹
        this._autoLog = [];                  // 自动检查记录，供真机验证确认「确实是自动跑的」
        this._pendingOrders = {};            // parentPath -> {ids, ts}，来自 filetreeSortChanged
        this._autoBusy = false;
        this._autoPending = false;
        this._autoTimer = null;
        this._notebookCache = null;
        this._notebookCacheAt = 0;
        this._configReady = this.loadConfig().catch((e) => {
            console.warn("[doc-num] 配置读取失败，用默认值", e);
            return null;
        });

        this.eventBus.on("open-menu-doctree", this.onDocTreeMenu.bind(this));
        this.eventBus.on("ws-main", this.onWsMain.bind(this));

        /* 正文标题编号 v0.5.0：命令面板里注册 5 个可改键命令（hotkey 留空，避免两套键互撞），
         * 真正的 Ctrl+Alt+1..5 用自定义 keydown 监听 —— 思源 addCommand 的 hotkey 用 Mac 符号，
         * 这里照 siyuan-xref-plugin 已验证的做法绑定用户指定的 Ctrl+Alt+N。 */
        for (let lv = 1; lv <= BN.LEVEL_MAX; lv++) {
            const level = lv;
            this.addCommand({
                langKey: "docNumBody" + level,
                langText: "正文标题：设为 " + level + " 级并编号",
                hotkey: "",
                callback: () => this.numberBodyAtCursor(level).catch((e) =>
                    msg("正文编号失败：" + e.message, 8000, "error")),
            });
        }
        this._onBodyHotkey = (ev) => this.onBodyHotkey(ev);
        if (typeof document !== "undefined") {
            document.addEventListener("keydown", this._onBodyHotkey, true);
        }

        this._topBar = this.addTopBar({
            icon: MENU_ICON,
            title: trText("标题体系自动编号：读取中…"),
            position: "right",
            callback: () => this.openPanel().catch((e) =>
                msg("面板打开失败：" + e.message, 6000, "error")),
        });
        // 预取笔记本列表，右键菜单同步判断「文档 / 笔记本」时不用等网络
        this.notebooks().catch(() => {});
        this.refreshTopBar();

        // 开发自检钩子：真机验证脚本通过 jsbridge 调插件本体，不依赖 UI 点击
        globalThis.__siyuanDocNumTest = this;
    }

    onunload() {
        if (this._autoTimer) clearTimeout(this._autoTimer);
        if (this._bodyTimer) clearTimeout(this._bodyTimer);
        if (this._bodyRetryTimer) clearTimeout(this._bodyRetryTimer);
        if (this._onBodyHotkey && typeof document !== "undefined") {
            document.removeEventListener("keydown", this._onBodyHotkey, true);
        }
        try { delete globalThis.__siyuanDocNumTest; } catch (e) { /* ignore */ }
    }

    /* ---------------- 配置 ---------------- */

    async loadConfig() {
        let raw = null;
        try { raw = await this.loadData(CONFIG_FILE); } catch (e) { /* 第一次运行没有该文件 */ }
        let obj = {};
        if (raw) {
            try { obj = typeof raw === "string" ? JSON.parse(raw) : raw; }
            catch (e) { obj = {}; }
        }
        const hadData = !!obj && Object.keys(obj).length > 0;
        const cfg = Object.assign({}, DEFAULT_CONFIG, obj || {});
        if (!Array.isArray(cfg.targets)) cfg.targets = [];
        if (!Array.isArray(cfg.excluded)) cfg.excluded = [];
        cfg.defaultFormats = DN.normalizeFormats(cfg.defaultFormats, DN.BUILTIN_V4_FORMATS);
        cfg.defaultCounters = DN.normalizeCounters(cfg.defaultCounters);
        cfg.defaultMaxLevel = DN.clampLevel(cfg.defaultMaxLevel);

        /* 一次性迁移：只有「磁盘上有旧配置 + 没打过版本标记 + 默认设置逐字等于 v0.3 内置」
         * 才把默认改成 v0.4 新体系。用户自定义过（哪怕只改了一级模板）一律不碰。
         * 只写设置，不动 enabled / targets / excluded，也不重排任何文档标题。 */
        let migrated = false;
        /* 必须看「磁盘原始值」：cfg 是 Object.assign 过 DEFAULT_CONFIG 的，
         * 里面 defaultsVersion 天生就是 2，拿它判旧配置会永远判不出来。 */
        const diskVersion = obj && obj.defaultsVersion != null ? Number(obj.defaultsVersion) : 0;
        if (hadData && diskVersion < 2) {
            const eqMap = (a, b) => [1, 2, 3, 4, 5].every((lv) => String(a[lv]) === String(b[lv]));
            const untouched = eqMap(cfg.defaultFormats, LEGACY_V3.formats)
                && eqMap(cfg.defaultCounters, LEGACY_V3.counters)
                && cfg.defaultMaxLevel === LEGACY_V3.maxLevel;
            if (untouched) {
                cfg.lastDefaultFormats = DN.normalizeFormats(LEGACY_V3.formats);
                cfg.defaultFormats = DN.normalizeFormats(DN.BUILTIN_V4_FORMATS);
                cfg.defaultCounters = DN.normalizeCounters(DN.BUILTIN_V4_COUNTERS);
                cfg.defaultMaxLevel = DN.BUILTIN_V4_MAX_LEVEL;
                migrated = true;
            }
            cfg.defaultsVersion = 2;
            this._config = cfg;
            this.saveConfig().catch((e) => console.warn("[doc-num] 默认设置迁移写入失败", e));
        }

        // 只规整「已经独立设过」的范围；没写的保持继承全局默认
        cfg.targets.forEach((t) => {
            if (t && t.formats) t.formats = DN.normalizeFormats(t.formats, DN.BUILTIN_V4_FORMATS);
            if (t && t.lastFormats) t.lastFormats = DN.normalizeFormats(t.lastFormats);
            if (t && t.counters) t.counters = DN.normalizeCounters(t.counters);
            if (t && t.maxLevel != null) t.maxLevel = DN.clampLevel(t.maxLevel);
        });

        /* v0.7.2（2026-11-07 17:53 用户要求）：第 3 级默认「第{n}部 {title}」→「第{n}篇{title}」。
         * 只替换**仍逐字等于旧内置默认**的位置（全局默认 + 各范围自己存的那一套），
         * 用户改过的模板一律不动；旧模板塞进 lastFormats / lastDefaultFormats 供剥旧号。
         * 只写设置，不重排任何文档标题；下次点「立即全部重排」才会按新模板改名。 */
        const OLD_P3 = "第{n}部 {title}", NEW_P3 = "第{n}篇{title}";
        let p3 = 0;
        if (cfg.defaultFormats && String(cfg.defaultFormats[3]) === OLD_P3) {
            cfg.lastDefaultFormats = cfg.lastDefaultFormats || DN.normalizeFormats(cfg.defaultFormats);
            cfg.defaultFormats = DN.normalizeFormats(Object.assign({}, cfg.defaultFormats, {3: NEW_P3}));
            p3++;
        }
        cfg.targets.forEach((t) => {
            if (!t || !t.formats || String(t.formats[3]) !== OLD_P3) return;
            const prev = DN.normalizeFormats(t.formats);
            t.formats = DN.normalizeFormats(Object.assign({}, t.formats, {3: NEW_P3}));
            t.lastFormats = t.lastFormats ? DN.normalizeFormats(t.lastFormats) : prev;
            p3++;
        });
        if (p3) {
            this._config = cfg;
            this.saveConfig().catch((e) => console.warn("[doc-num] 第3级默认模板迁移写入失败", e));
        }

        this._config = cfg;
        if (migrated) console.info("[doc-num] 默认编号设置已迁移到 v0.4 五级体系（未改动任何文档标题）");
        if (p3) console.info("[doc-num] 第 3 级默认模板已由「第N部」改为「第N篇」（共 " + p3 + " 处，未改动任何文档标题）");
        return cfg;
    }

    async saveConfig() {
        await this.saveData(CONFIG_FILE, JSON.stringify(this._config, null, 2));
    }

    async getConfig() {
        await this._configReady;
        return this._config;
    }

    async notebooks() {
        const now = Date.now();
        if (this._notebookCache && now - this._notebookCacheAt < 30000) return this._notebookCache;
        const d = await api("/api/notebook/lsNotebooks", {});
        this._notebookCache = (d && d.notebooks) || [];
        this._notebookCacheAt = now;
        return this._notebookCache;
    }

    refreshTopBar() {
        if (!this._topBar) return;
        const cfg = this._config || DEFAULT_CONFIG;
        const label = "标题体系：" + (cfg.enabled ? "已启用" : "已暂停")
            + "，" + cfg.targets.length + " 个范围（点击查看/管理）";
        const el = this._topBar.element || this._topBar;
        if (el && el.setAttribute) el.setAttribute("title", label);
        if (this._topBar && this._topBar.setAttribute) this._topBar.setAttribute("title", label);
    }

    /* ---------------- 菜单：范围选择 ---------------- */

    onDocTreeMenu(event) {
        const detail = event && event.detail;
        if (!detail || !detail.menu || !detail.elements || !detail.elements.length) return;

        const el = detail.elements[0];
        const nodeEl = (el.closest && el.closest("li[data-type]")) || el;
        if (!nodeEl || !nodeEl.getAttribute) return;
        const domType = (nodeEl.getAttribute("data-type") || "").toLowerCase();

        /* 实测（思源 3.8.9）：笔记本节点 li[data-type="navigation-root"] 的
         * data-node-id 是空字符串，笔记本 ID 在父级 ul[data-url] 上。
         * 旧版按 data-node-id 取 ID，右键笔记本会直接 return，菜单根本不出现。 */
        if (domType === "navigation-root") {
            const ul = nodeEl.parentElement;
            const box = (ul && ul.getAttribute("data-url"))
                || nodeEl.getAttribute("data-node-id") || "";
            if (!box || !ID_RE.test(box)) return;
            const books = this._notebookCache || [];
            const book = books.find((b) => b.id === box);
            const textEl = nodeEl.querySelector(".b3-list-item__text");
            const name = (book && book.name) || (textEl && String(textEl.textContent).trim()) || "笔记本";
            const nbTarget = {type: "notebook", id: box, name};
            detail.menu.addItem({
                icon: MENU_ICON,
                label: trText("编号：文档标题 + 内容标题"),
                click: () => this.numberBoth(nbTarget).catch((e) =>
                    msg("编号失败：" + e.message, 8000, "error")),
            });
            this.addRangeMenuItem(detail.menu, nbTarget);
            detail.menu.addItem({type: "separator"});
            detail.menu.addItem({
                icon: "iconUndo",
                label: trText("撤销"),
                submenu: [
                    {icon: "iconFiles", label: trText("撤销文档标题编号"),
                     click: () => this.undoNumbering().catch((e) =>
                         msg("撤销失败：" + e.message, 8000, "error"))},
                    {icon: "iconFiles", label: trText("撤销内容标题编号"),
                     click: () => this.undoBodyNumbering().catch((e) =>
                         msg("撤销失败：" + e.message, 8000, "error"))},
                ],
            });
            return;
        }
        if (domType !== "navigation-file") return;   // 标签 / 附件等节点不挂

        const id = nodeEl.getAttribute("data-node-id") || "";
        if (!id || !ID_RE.test(id)) return;
        // 菜单必须同步挂载：右键菜单会在 await 期间关闭，慢一拍菜单项就不出现
        const target = {
            type: "doc", id,
            box: nodeEl.getAttribute("data-box") || "",   // 空也没关系，collect 会自己查
            name: nodeEl.getAttribute("data-name") || id,
        };
        detail.menu.addItem({
            icon: MENU_ICON,
            label: trText("编号：文档标题 + 内容标题"),
            click: () => this.numberBoth(target).catch((e) =>
                msg("编号失败：" + e.message, 8000, "error")),
        });
        detail.menu.addItem({
            icon: "iconRefresh",
            label: trText("只编号内容标题"),
            click: () => this.numberBodyOnly(target).catch((e) =>
                msg("编号失败：" + e.message, 8000, "error")),
        });
        this.addRangeMenuItem(detail.menu, target);
        this.addExcludeMenuItems(detail.menu, target);
        detail.menu.addItem({type: "separator"});
        detail.menu.addItem({
            icon: "iconUndo",
            label: trText("撤销"),
            submenu: [
                {icon: "iconFiles", label: trText("撤销文档标题编号"),
                 click: () => this.undoNumbering().catch((e) =>
                     msg("撤销失败：" + e.message, 8000, "error"))},
                {icon: "iconFiles", label: trText("撤销内容标题编号"),
                 click: () => this.undoBodyNumbering().catch((e) =>
                     msg("撤销失败：" + e.message, 8000, "error"))},
            ],
        });
    }

    /** 排除 / 取消排除收进一个子菜单，右键菜单不再被三个同义项撑长。 */
    addExcludeMenuItems(menu, target) {
        const cfg = this._config || DEFAULT_CONFIG;
        const found = (cfg.excluded || []).find((e) => e.id === target.id);
        const sub = found
            ? [{icon: "iconCheck", label: trText("取消排除（恢复参与编号）"),
                click: () => this.toggleExclude(target, "off").catch((e) =>
                    msg("取消排除失败：" + e.message, 8000, "error"))}]
            : [{icon: "iconClose", label: trText("仅自身不编号（子文档照常）"),
                click: () => this.toggleExclude(target, "self").catch((e) =>
                    msg("排除失败：" + e.message, 8000, "error"))},
               {icon: "iconClose", label: trText("整支不编号（含子文档）"),
                click: () => this.toggleExclude(target, "subtree").catch((e) =>
                    msg("排除失败：" + e.message, 8000, "error"))}];
        menu.addItem({
            icon: found ? "iconCheck" : "iconClose",
            label: found ? "排除（当前已排除）" : "排除此文档",
            submenu: sub,
        });
    }

    /** 右键「只编号内容标题」：不动文档名，只重排该子树的 H1~H5。 */
    async numberBodyOnly(target, opt) {
        const o = opt || {};
        const ids = await this.idsForTarget({type: target.type || "doc", id: target.id, box: target.box});
        if (!ids.length) return {ok: false, reason: "no-docs"};
        const r = await this.numberBodyRange(ids, {source: "menu", silent: !o.verbose});
        if (!o.silent) {
            msg(r.ok ? ("已给 " + (r.docsHit || 0) + " 篇、共 " + (r.changed || 0) + " 处内容标题编号")
                             : ("编号中断，已改 " + (r.changed || 0) + " 处，可在面板撤销"),
                        r.ok ? 7000 : 9000, r.ok ? "info" : "error");
        }
        return r;
    }

    /** mode: "self" 只排除自身 / "subtree" 连子文档 / "off" 取消排除 */
    async toggleExclude(target, mode) {
        await this._configReady;
        const cfg = this._config;
        if (!Array.isArray(cfg.excluded)) cfg.excluded = [];
        const i = cfg.excluded.findIndex((e) => e.id === target.id);
        if (i >= 0) cfg.excluded.splice(i, 1);
        let name = target.name || target.id;
        if (mode !== "off") {
            if (!name || name === target.id) {
                try {
                    const rows = await sql("SELECT content FROM blocks WHERE id='" + esc(target.id) + "' LIMIT 1");
                    if (rows && rows[0]) name = rows[0].content || target.id;
                } catch (e) { /* 用 id 兜底 */ }
            }
            cfg.excluded.push({id: target.id, name, mode});
        }
        await this.saveConfig();
        this._fp = {};               // 配置变了，强制下一轮检查重新算
        // 立即对已设范围重排，让「排除 / 取消排除」当场生效（配置变化本身不发 ws 事件）
        const results = [];
        for (const t of cfg.targets.slice()) {
            try { results.push({changed: (await this.runNumbering(t, {silent: true, source: "exclude"})).changed}); }
            catch (e) { results.push({error: e.message}); }
        }
        if (mode !== "off") {
            msg("已排除「" + name + "」" + (mode === "subtree" ? "及其子文档" : "（仅自身）")
                + "，编号已重排", 7000, "info");
        } else {
            msg("已取消排除「" + (target.name || target.id) + "」，编号已重排", 7000, "info");
        }
        return {ok: true, excluded: cfg.excluded.slice(), results};
    }

    addRangeMenuItem(menu, target) {
        const cfg = this._config || DEFAULT_CONFIG;
        const key = targetKey(target);
        const on = cfg.targets.some((t) => targetKey(t) === key);
        menu.addItem({
            icon: on ? "iconClose" : "iconCheck",
            label: on ? "取消该范围的自动编号" : "设为自动编号范围（新增/删除/拖动自动重排）",
            click: () => this.toggleTarget(target).catch((e) =>
                msg("设置失败：" + e.message, 8000, "error")),
        });
    }

    async toggleTarget(target) {
        await this._configReady;
        const cfg = this._config;
        const key = targetKey(target);
        const i = cfg.targets.findIndex((t) => targetKey(t) === key);
        if (i >= 0) {
            cfg.targets.splice(i, 1);
            delete this._fp[key];
            await this.saveConfig();
            this.refreshTopBar();
            msg("已取消自动编号范围：" + target.name, 5000, "info");
            return {ok: true, enabled: false};
        }
        // 菜单是同步挂的，没来得及查 box/name；这里补齐再存（collect 也能自己查，但配置里要有可读名字）
        if (target.type === "doc" && (!target.box || !target.name || target.name === target.id)) {
            try {
                const rows = await sql("SELECT box, content FROM blocks WHERE id='" + esc(target.id) + "' LIMIT 1");
                if (rows && rows[0]) {
                    target.box = target.box || rows[0].box;
                    if (!target.name || target.name === target.id) target.name = rows[0].content || target.id;
                }
            } catch (e) { /* 用 id 兜底即可 */ }
        }
        cfg.targets.push(target);
        cfg.enabled = true;
        delete this._fp[key];
        await this.saveConfig();
        this.refreshTopBar();
        msg("已设为自动编号范围：" + target.name + "。现在新增 / 删除 / 拖动子文档会自动重排编号", 8000, "info");
        // 设定后立刻编一次，省得用户还要手动点
        try { await this.runNumbering(target, {silent: true}); } catch (e) { /* 不阻断设置 */ }
        return {ok: true, enabled: true};
    }

    /** 供面板 / 真机验证读某一范围的完整编号设置。 */
    async getFormats(scope) {
        await this._configReady;
        const key = scope || DEFAULT_SCOPE;
        const spec = scopeSpec(this._config, key);
        return {scope: key, formats: spec.formats, counters: spec.counters, maxLevel: spec.maxLevel};
    }

    /**
     * 保存编号设置并立刻重排（配置变化不发 ws 事件，不主动跑就不会生效）。
     * scope = "__default__" 改全局默认；否则是某个 targetKey（每个范围各一套）。
     * spec 可传完整 {maxLevel, formats, counters}，也可只传旧的纯 formats 对象（向后兼容）。
     * 换格式前把旧模板记进 lastFormats，核心据此剥掉旧编号前缀，避免叠成双前缀。
     */
    async applyFormats(scope, spec, opt) {
        const o = opt || {};
        await this._configReady;
        const cfg = this._config;
        const key = scope || DEFAULT_SCOPE;
        const cur = scopeSpec(cfg, key);
        if (spec && spec.formats) {
            const bad = badPlaceholders(DN.normalizeFormats(spec.formats, DN.BUILTIN_V4_FORMATS));
            if (bad.length) {
                throw new Error("模板里有不认识的占位符：" + bad.join("、")
                    + "。文档标题可用 {fn1}~{fn5}、{fn}、{n}、{nn}、{parentN}、{parentNN}、{title}、{h1}、{cn}");
            }
        }
        const isSpec = spec && (spec.formats || spec.counters || spec.maxLevel != null);
        const incoming = isSpec ? spec : {formats: spec};
        const next = {
            maxLevel: incoming.maxLevel != null ? DN.clampLevel(incoming.maxLevel) : cur.maxLevel,
            formats: DN.normalizeFormats(incoming.formats || cur.formats, DN.BUILTIN_V4_FORMATS),
            counters: DN.normalizeCounters(incoming.counters || cur.counters),
        };
        let reran = 0;
        const errors = [];
        const inherits = (x) => !x.formats && !x.counters && x.maxLevel == null;

        if (key === DEFAULT_SCOPE) {
            cfg.lastDefaultFormats = cur.formats;   // 旧默认模板，换回去时靠它剥旧号
            cfg.defaultFormatsHistory = pushFormatsHistory(cfg.defaultFormatsHistory, cur.formats);
            cfg.defaultFormats = next.formats;
            cfg.defaultCounters = next.counters;
            cfg.defaultMaxLevel = next.maxLevel;
            await this.saveConfig();
            this._fp = {};
            // 只有「完全继承默认」的范围会跟着变；独立设过的不动
            for (const t of cfg.targets.filter(inherits).slice()) {
                try { await this.runNumbering(t, {silent: true, source: "format"}); reran++; }
                catch (e) { errors.push(e.message); }
            }
        } else {
            const t = (cfg.targets || []).find((x) => targetKey(x) === key);
            if (!t) throw new Error("找不到这个自动编号范围：" + key);
            t.lastFormats = cur.formats;
            t.formatsHistory = pushFormatsHistory(t.formatsHistory, cur.formats);
            t.formats = next.formats;
            t.counters = next.counters;
            t.maxLevel = next.maxLevel;
            await this.saveConfig();
            delete this._fp[key];
            try { await this.runNumbering(t, {silent: true, source: "format"}); reran++; }
            catch (e) { errors.push(e.message); }
        }
        if (!o.silent) {
            msg("编号设置已保存（" + next.maxLevel + " 级），已重排 " + reran + " 个范围", 6000,
                errors.length ? "error" : "info");
        }
        return {ok: !errors.length, scope: key, formats: next.formats,
                counters: next.counters, maxLevel: next.maxLevel, reran, errors};
    }

    /** 恢复内置默认：模板、计数方式、层级数一起回到 v0.4 五级新体系。 */
    async resetFormats(scope, opt) {
        return this.applyFormats(scope, {
            formats: DN.BUILTIN_V4_FORMATS,
            counters: DN.BUILTIN_V4_COUNTERS,
            maxLevel: DN.BUILTIN_V4_MAX_LEVEL,
        }, opt);
    }

    async setConfig(patch) {
        await this._configReady;
        Object.assign(this._config, patch || {});
        await this.saveConfig();
        this.refreshTopBar();
        return this._config;
    }

    async clearTargets() {
        await this._configReady;
        this._config.targets = [];
        this._fp = {};
        await this.saveConfig();
        this.refreshTopBar();
        return this._config;
    }

    /* ---------------- 顶栏面板 ---------------- */

    async openPanel() {
        await this._configReady;
        const cfg = this._config;
        const IC = PANEL_ICONS;

        /* 列表项：图标 + 名称 + 截断的 ID + 类型标签 + 悬停才显眼的移除按钮 */
        const listItem = (icon, name, meta, badge, action, i) =>
            "<div class='dn-item'>"
            + "<span class='dn-item__icon'>" + icon + "</span>"
            + "<div class='dn-item__body'>"
            + "<div class='dn-item__name'>" + escHtml(name) + "</div>"
            + "<div class='dn-item__meta' title='" + escHtml(meta) + "'>" + escHtml(meta) + "</div>"
            + "</div>"
            + "<span class='dn-item__badge'>" + escHtml(badge) + "</span>"
            + "<button class='dn-remove' data-" + action + "='" + i + "' aria-label='移除' title='移除'>"
            + IC.remove + "</button></div>";
        const empty = (text) => "<div class='dn-empty'>" + IC.info + "<span>" + text + "</span></div>";
        const rows = cfg.targets.length
            ? "<div class='dn-list'>" + cfg.targets.map((t, i) => listItem(
                t.type === "notebook" ? IC.notebook : IC.doc,
                t.name || t.id, t.id,
                t.type === "notebook" ? "笔记本" : "文档",
                "rm", i)).join("") + "</div>"
            : empty("还没有设定范围 · 在文档树里<b>右键某篇文档或笔记本</b> →「设为自动编号范围」");
        const exRows = cfg.excluded.length
            ? "<div class='dn-list'>" + cfg.excluded.map((e, i) => listItem(
                IC.doc, e.name, e.id,
                e.mode === "subtree" ? "整支" : "仅自身",
                "exrm", i)).join("") + "</div>"
            : empty("没有排除的文档 · 在文档树里<b>右键某篇文档</b> →「排除此文档」");

        const scopeOptions = "<option value='" + DEFAULT_SCOPE + "'>默认设置</option>"
            + cfg.targets.map((t) => "<option value='" + escHtml(targetKey(t)) + "'>"
                + (t.type === "notebook" ? "笔记本" : "文档") + " · "
                + escHtml(t.name || t.id)
                + ((t.formats || t.counters || t.maxLevel != null) ? " · 已自定义" : "")
                + "</option>").join("");
        const spec0 = scopeSpec(cfg, DEFAULT_SCOPE);
        /* 层级标签保持中性：模板可自定义，写死「部/章/节」会和自定义格式打架。 */
        const levelNames = {
            1: "一级", 2: "二级", 3: "三级", 4: "四级", 5: "五级",
        };
        const levelShort = {1: "级", 2: "级", 3: "级", 4: "级", 5: "级"};
        const docRows = [1, 2, 3, 4, 5].map((lv) =>
            "<div class='dn-table__row' data-lvrow='" + lv + "'>"
            + "<span class='dn-lv'><span class='dn-lv__num'>" + lv + "</span>" + levelShort[lv] + "</span>"
            + "<input class='b3-text-field' id='dn-f" + lv + "' value='"
            + escHtml(spec0.formats[lv]) + "'>"
            + "<select class='b3-select' id='dn-c" + lv + "'>"
            + "<option value='global'" + (spec0.counters[lv] === "global" ? " selected" : "") + ">全书连续</option>"
            + "<option value='local'" + (spec0.counters[lv] === "local" ? " selected" : "") + ">按上级重排</option>"
            + "<option value='grandlocal'" + (spec0.counters[lv] === "grandlocal" ? " selected" : "") + ">按上上级重排</option>"
            + "</select>"
            + "<button type='button' class='dn-remove dn-lvdel' data-lvdel='" + lv + "'"
            + " aria-label='删除第 " + lv + " 级' title='删除该级，后面各级自动上移补位'>"
            + IC.remove + "</button></div>").join("");

        /* 内容标题模板（v0.5.0 起）：五级各一行，与文档标题共用一套 fn/hn 词表，null = 内置默认 */
        const bodySpec = cfg.bodyFormats
            ? BN.normalizeBodyFormats(cfg.bodyFormats)
            : BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS);
        const bodyRows = [1, 2, 3, 4, 5].map((lv) =>
            "<div class='dn-table__row dn-table__row--body' data-bfrow='" + lv + "'>"
            + "<span class='dn-lv'><span class='dn-lv__num dn-lv__num--body'>" + lv + "</span>"
            + levelShort[lv] + "</span>"
            + "<input class='b3-text-field' id='dn-bf" + lv + "' value='"
            + escHtml(bodySpec[lv]) + "'>"
            + "<span class='dn-cells dn-cells--muted' title='内容层级没有计数方式：序号在篇内按层级自然递增'>随层级</span>"
            + "<span class='dn-cells dn-cells--tail'></span></div>").join("");

        /* 结构照思源原生对话框：内容区（可滚动）+ 底部操作条（固定）。
         * 所有 ID / data-* 保持与旧版一致，验证脚本与事件绑定都不用改。 */
        const html = "<style id='dn-panel-style'>" + PANEL_CSS + "</style>"
            + "<div class='b3-dialog__content dn-root'>"
            + "<div class='dn-hero' id='dn-hero'>"
            + "<span class='dn-hero__icon'>" + IC.list + "</span>"
            + "<div class='dn-hero__body'>"
            + "<div class='dn-hero__title'>树文联动编号</div>"
            + "<div class='dn-hero__desc' id='dn-hero__desc'>新增 / 删除 / 拖动 / 改名后约 "
            + Math.round(cfg.debounceMs / 100) / 10 + " 秒自动重排 · 只改标题，不动正文与 ID</div>"
            + "</div>"
            + "<input type='checkbox' class='b3-switch' id='dn-enabled' "
            + "aria-label='启用自动编号' title='启用 / 暂停自动编号' " + (cfg.enabled ? "checked" : "") + ">"
            + "</div>"
            + "<div class='dn-opt'>"
            + "<div class='dn-opt__body'>"
            + "<div class='dn-opt__title'>跳过未命名文档</div>"
            + "<div class='dn-opt__desc'>「无标题 / 无命名文档 / Untitled」等不编号、不占号，改好名字后自动补号</div>"
            + "</div>"
            + "<input type='checkbox' class='b3-switch' id='dn-skiptitle' "
            + "aria-label='跳过未命名文档' title='跳过占位标题' " + (cfg.skipUntitled ? "checked" : "") + ">"
            + "</div>"
            + "<section class='dn-sec' id='dn-titlesec'>"
            + "<div class='dn-sec__head'><span class='dn-sec__title'>标题体系</span>"
            + "<span class='dn-sec__desc'>文档标题与内容标题共用一套编号词表 · 每个范围各存一套</span></div>"
            + "<div class='dn-toolbar'>"
            + "<div class='dn-field dn-field--scope'><span class='dn-field__label'>作用于</span>"
            + "<select class='b3-select' id='dn-scope'>" + scopeOptions + "</select></div>"
            + "<div class='dn-field'><span class='dn-field__label'>编号到第</span>"
            + "<div class='dn-stepper'>"
            + "<button class='dn-step' id='dn-lvminus' aria-label='减少层级'>−</button>"
            + "<b id='dn-maxlevel'>" + spec0.maxLevel + "</b>"
            + "<button class='dn-step' id='dn-lvplus' aria-label='增加层级'>+</button>"
            + "</div><span class='dn-field__label'>级（1–5）</span></div>"
            + "</div>"
            + "<div class='dn-table'>"
            + "<div class='dn-table__head'><span>层级</span><span>编号模板</span><span>计数方式</span><span></span></div>"
            + "<div class='dn-group'><span class='dn-group__dot'></span>文档标题"
            + "<span class='dn-group__hint'>改文档名 · 跟随文档树顺序</span></div>"
            + docRows
            + "<div class='dn-group' id='dn-bodysec'><span class='dn-group__dot dn-group__dot--body'></span>内容标题"
            + "<span class='dn-group__hint'>改文档内的 H1~H5 · 前缀取本档编号</span></div>"
            + bodyRows + "</div>"
            + "<div class='dn-legend'>"
            + "<span class='dn-tag'><code>{fn1}…{fn5}</code> 文档第 K 级号</span>"
            + "<span class='dn-tag'><code>{fn}</code> 本文档号</span>"
            + "<span class='dn-tag'><code>{hn1}…{hn5}</code> 内容第 K 级号</span>"
            + "<span class='dn-tag'><code>{hn}</code> 内容连号</span>"
            + "<span class='dn-tag'><code>{title}</code> 原标题</span>"
            + "<span class='dn-tag dn-tag--fmt'><code>{fn1:cn}</code> 中文</span>"
            + "<span class='dn-tag dn-tag--fmt'><code>{fn1:CN}</code> 大写</span>"
            + "<span class='dn-tag dn-tag--fmt'><code>{fn1:a}</code> 字母</span>"
            + "<span class='dn-tag dn-tag--fmt'><code>{fn1:o}</code> 圈码</span>"
            + "<span class='dn-tag dn-tag--fmt'><code>{fn1:03}</code> 补零</span>"
            + "<span class='dn-legend__hint'>数字格式接在名字后面：<code>:cn</code> 一 · <code>:CN</code> 壹 · "
            + "<code>:a</code> 字母 · <code>:o</code> ① · <code>:i</code> 罗马 · <code>:03</code> 补零到 3 位；"
            + "复合号（2.1）逐段转换 → <code>二.一</code>、<code>02.01</code>。只要本级序号用 <code>{n}</code>。</span>"
            + "<span class='dn-legend__hint'>完整号自己拼：<code>{fn1}.{fn2}.{fn3}.{fn4}</code> → <code>1.1.1.4</code>；"
            + "<code>{fn4}</code> 只取第 4 级那一段（=4），不再返回整条号。</span>"
            + "<span class='dn-legend__hint'><code>{prefix}</code> = 实际显示的号（不是全链）："
            + "文档标题里取<b>上一级</b>的显示号（如 1.1，第 1 级没有上级→为空，可写 <code>第{prefix}.{n}节</code>）；"
            + "内容标题里取<b>本文档</b>的显示号。</span>"
            + "<span class='dn-legend__hint'>旧写法照样能用：<code>{n}</code>=本级、<code>{nn}</code>=补零、"
            + "<code>{parentN}</code>=上级、<code>{prefix}</code>=本文档号、<code>{h1}</code>=所属一级、<code>{cn}</code>=①</span>"
            + "</div>"
            + "<div class='dn-opt dn-opt--tight'>"
            + "<div class='dn-opt__body'>"
            + "<div class='dn-opt__title'>内容标题快捷键 Ctrl+Alt+1…5</div>"
            + "<div class='dn-opt__desc'>把光标所在段落设为对应级标题并编号；没有文档编号的篇自动跳过</div>"
            + "</div>"
            + "<input type='checkbox' class='b3-switch' id='dn-bodyen' "
            + "aria-label='启用内容标题快捷键' title='Ctrl+Alt+1…5 开关' "
            + (cfg.bodyEnabled === false ? "" : "checked") + ">"
            + "</div>"
            + "<div class='dn-opt dn-opt--tight'>"
            + "<div class='dn-opt__body'>"
            + "<div class='dn-opt__title'>内容标题变化后自动重算</div>"
            + "<div class='dn-opt__desc'>编号范围内文档的标题增删改后，停顿 1.5 秒自动重排</div>"
            + "</div>"
            + "<input type='checkbox' class='b3-switch' id='dn-bodyauto' "
            + "aria-label='内容标题自动重算开关' title='作用于「自动编号范围」内的文档' "
            + (cfg.bodyAuto === true ? "checked" : "") + ">"
            + "</div>"
            + "<div class='dn-preview'>"
            + "<div class='dn-preview__label'>实时预览</div>"
            + "<div class='dn-pv__cap'>文档标题</div>"
            + "<div id='dn-preview'></div>"
            + "<div class='dn-pv__cap dn-pv__cap--sep'>内容标题（示例文档「第2.1节 …」）</div>"
            + "<div id='dn-bpreview'></div>"
            + "</div>"
            + "<div class='dn-sec__actions'>"
            + "<button class='b3-button b3-button--text dn-a-left' id='dn-bundo'>撤销上次内容编号</button>"
            + "<button class='b3-button b3-button--text' id='dn-brun' "
            + "title='把范围内每篇的内容标题按当前模板编一遍；可整批撤销'>立即编内容</button>"
            + "<button class='b3-button b3-button--text' id='dn-freset'>恢复内置默认</button>"
            + "<button class='b3-button' id='dn-fsave'>保存并应用</button>"
            + "</div></section>"
            + "<section class='dn-sec'><div class='dn-sec__head'>"
            + "<span class='dn-sec__title'>自动编号范围</span>"
            + "<span class='dn-count'>" + cfg.targets.length + "</span>"
            + "<span class='dn-sec__desc'>每级顺序跟随文档树自定义排序</span></div>"
            + rows + "</section>"
            + "<section class='dn-sec'><div class='dn-sec__head'>"
            + "<span class='dn-sec__title'>排除的文档</span>"
            + "<span class='dn-count'>" + cfg.excluded.length + "</span>"
            + "<span class='dn-sec__desc'>剥掉旧编号、不占号</span></div>"
            + exRows + "</section>"
            + "<div class='dn-foot'>换格式 / 减少层级会自动剥掉旧编号再套新格式。"
            + "「第1章」与新内置模板同形，会被当作插件编号剥掉（中文数字「第一章」保留）。"
            + "排除「仅自身」时子文档照常编号，「整支」则连子文档都不编号。"
            + "撤销后自动编号会暂停，到此处重新开启。</div>"
            + "</div>"
            + "<div class='b3-dialog__action dn-actions'>"
            + "<div class='dn-actions__left'>"
            + "<button class='b3-button b3-button--text' id='dn-undo'>撤销上次编号</button></div>"
            + "<div class='dn-actions__right'>"
            + "<button class='b3-button b3-button--outline' id='dn-run'>立即全部重排</button>"
            + "<button class='b3-button b3-button--text' id='dn-close'>关闭</button></div>"
            + "</div>";

        const dlg = new Dialog({title: trText("树文联动编号"), content: trText(html),
                                width: "640px", height: "min(92vh, 960px)"});
        const root = dlg.element;
        trDom(root);
        const q = (s) => root.querySelector(s);
        const selScope = q("#dn-scope");
        const fInputs = [1, 2, 3, 4, 5].map((lv) => q("#dn-f" + lv));
        const cSelects = [1, 2, 3, 4, 5].map((lv) => q("#dn-c" + lv));
        const preview = q("#dn-preview");
        const maxEl = q("#dn-maxlevel");
        let curMax = spec0.maxLevel;
        const currentSpec = () => {
            const formats = {}, counters = {};
            fInputs.forEach((el, i) => { formats[i + 1] = el ? el.value : ""; });
            cSelects.forEach((el, i) => { counters[i + 1] = el ? el.value : "global"; });
            return {maxLevel: curMax, formats, counters};
        };
        const showRows = () => {
            for (let lv = 1; lv <= DN.MAX_LEVEL; lv++) {
                const row = root.querySelector('[data-lvrow="' + lv + '"]');
                if (row) row.style.display = lv <= curMax ? "flex" : "none";
            }
            if (maxEl) maxEl.textContent = String(curMax);
            root.querySelectorAll("[data-lvdel]").forEach((b) => { b.disabled = curMax <= 1; });
        };
        const paintPreview = () => {
            if (!preview) return;
            const s = currentSpec();
            const samples = ["绪论", "研究背景", "国内外现状", "条目示例", "款目示例"];
            const idxs = [1, 3, 2, 4, 5];
            preview.innerHTML = samples.slice(0, curMax).map((base, i) => {
                /* 示例链：一级 1、二级 3、三级 2…（与下方内容预览的 2.1 不同，
                 * 文档预览关心的是「本级模板长什么样」。 */
                const chain = [];
                for (let j = 0; j <= i; j++) chain[j + 1] = idxs[j];
                return "<div><span class='dn-pv__lv'>" + levelNames[i + 1] + " →</span> <b>"
                    + escHtml(DN.renderTemplate(s.formats[i + 1], i + 1, idxs[i], base,
                        {parentIndex: i > 0 ? idxs[i - 1] : 0, fn: chain,
                         fallback: DN.BUILTIN_V4_FORMATS}))
                    + "</b></div>";
            }).join("");
        };
        /* 顶部状态卡跟随总开关：暂停时整块褪成中性色，一眼能看出没在自动编号 */
        const hero = q("#dn-hero");
        const heroDesc = q("#dn-hero__desc");
        const paintHero = (on) => {
            if (hero) hero.classList.toggle("dn-hero--off", !on);
            if (heroDesc) heroDesc.textContent = on
                ? "新增 / 删除 / 拖动 / 改名后约 " + Math.round(cfg.debounceMs / 100) / 10
                    + " 秒自动重排 · 只改标题，不动正文与 ID"
                : "自动编号已暂停 · 在文档树里手动右键仍可编号";
        };
        const fillSpec = (sp) => {
            fInputs.forEach((el, i) => { if (el) el.value = sp.formats[i + 1]; });
            cSelects.forEach((el, i) => { if (el) el.value = sp.counters[i + 1]; });
            curMax = sp.maxLevel;
            showRows();
            paintPreview();
        };
        if (selScope) selScope.addEventListener("change", (e) => {
            fillSpec(scopeSpec(cfg, e.target.value));
        });
        fInputs.forEach((el) => { if (el) el.addEventListener("input", paintPreview); });
        cSelects.forEach((el) => { if (el) el.addEventListener("change", paintPreview); });
        const btnMinus = q("#dn-lvminus");
        if (btnMinus) btnMinus.addEventListener("click", () => {
            curMax = Math.max(1, curMax - 1); showRows(); paintPreview();
        });
        const btnPlus = q("#dn-lvplus");
        if (btnPlus) btnPlus.addEventListener("click", () => {
            curMax = Math.min(DN.MAX_LEVEL, curMax + 1); showRows(); paintPreview();
        });
        /* 每行末尾的删除号：删掉该级，后面各级模板 / 计数方式依次上移补位。
         * 删最后一级等价于减一层（模板保留，按 + 可加回）；最少保留 1 级。 */
        root.querySelectorAll("[data-lvdel]").forEach((b) => {
            b.addEventListener("click", () => {
                if (curMax <= 1) return;
                const lv = Number(b.getAttribute("data-lvdel"));
                if (!lv || lv > curMax) return;
                if (lv < curMax) {
                    for (let i = lv; i < DN.MAX_LEVEL; i++) {
                        const fSrc = fInputs[i], fDst = fInputs[i - 1];
                        const cSrc = cSelects[i], cDst = cSelects[i - 1];
                        if (fSrc && fDst) fDst.value = fSrc.value;
                        if (cSrc && cDst) cDst.value = cSrc.value;
                    }
                    const lf = fInputs[DN.MAX_LEVEL - 1], lc = cSelects[DN.MAX_LEVEL - 1];
                    if (lf) lf.value = DN.BUILTIN_V4_FORMATS[DN.MAX_LEVEL];
                    if (lc) lc.value = DN.BUILTIN_V4_COUNTERS[DN.MAX_LEVEL];
                }
                curMax = Math.max(1, curMax - 1);
                showRows(); paintPreview();
            });
        });
        fillSpec(spec0);
        /* v0.7.0：文档标题模板与内容标题模板属同一套「标题体系」，一个按钮一起存，
         * 不再分两个「保存并应用」——那正是用户说的「不该割裂开来」。 */
        const btnSaveFmt = q("#dn-fsave");
        if (btnSaveFmt) btnSaveFmt.addEventListener("click", async () => {
            const scope = selScope ? selScope.value : DEFAULT_SCOPE;
            const bt = {};
            [1, 2, 3, 4, 5].forEach((lv) => {
                const el = q("#dn-bf" + lv);
                bt[lv] = el ? el.value : "";
            });
            try {
                const saved = await this.saveBodyFormats(bt);
                await this.applyFormats(scope, currentSpec());
                dlg.destroy();
                /* v0.8.2：正文模板换了 → 立刻按新模板重排范围内正文（先剔老号）。
                 * 以前只存设置，要等你自己点「现在编」，老编号就一直挂在那儿。 */
                if (saved && saved.changed) {
                    msg("正文模板已切换，正在按新模板重排（会先剔除老编号）…", 4000, "info");
                    this.rerunBodyForSwitch({source: "format-switch"}).catch((e) =>
                        msg("正文重排失败：" + e.message, 9000, "error"));
                }
            } catch (e) {
                msg("编号设置保存失败：" + e.message, 8000, "error");
            }
        });
        const btnResetFmt = q("#dn-freset");
        if (btnResetFmt) btnResetFmt.addEventListener("click", async () => {
            const scope = selScope ? selScope.value : DEFAULT_SCOPE;
            fillSpec({formats: DN.BUILTIN_V4_FORMATS, counters: DN.BUILTIN_V4_COUNTERS,
                      maxLevel: DN.BUILTIN_V4_MAX_LEVEL});
            [1, 2, 3, 4, 5].forEach((lv) => {
                const el = q("#dn-bf" + lv);
                if (el) el.value = BN.BUILTIN_BODY_FORMATS[lv];
            });
            try {
                const saved = await this.saveBodyFormats(BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS));
                await this.resetFormats(scope);
                dlg.destroy();
                if (saved && saved.changed) {
                    msg("已恢复内置正文模板，正在重排（会先剔除老编号）…", 4000, "info");
                    this.rerunBodyForSwitch({source: "format-reset"}).catch((e) =>
                        msg("正文重排失败：" + e.message, 9000, "error"));
                }
            } catch (e) {
                msg("恢复默认失败：" + e.message, 8000, "error");
            }
        });

        const cbEnabled = q("#dn-enabled");
        paintHero(cfg.enabled);
        if (cbEnabled) cbEnabled.addEventListener("change", (e) => {
            cfg.enabled = e.target.checked;
            paintHero(cfg.enabled);
            this.saveConfig().then(() => this.refreshTopBar());
        });
        const cbSkip = q("#dn-skiptitle");
        if (cbSkip) cbSkip.addEventListener("change", (e) => {
            cfg.skipUntitled = e.target.checked;
            this.saveConfig();
        });
        root.querySelectorAll("[data-rm]").forEach((b) => {
            b.addEventListener("click", () => {
                const i = Number(b.getAttribute("data-rm"));
                const removed = cfg.targets.splice(i, 1)[0];
                if (removed) delete this._fp[targetKey(removed)];
                this.saveConfig().then(() => { this.refreshTopBar(); dlg.destroy(); });
            });
        });
        root.querySelectorAll("[data-exrm]").forEach((b) => {
            b.addEventListener("click", () => {
                const i = Number(b.getAttribute("data-exrm"));
                cfg.excluded.splice(i, 1);
                this._fp = {};
                this.saveConfig().then(() => {
                    this.runAll({silent: true}).catch(() => {});
                    this.refreshTopBar();
                    dlg.destroy();
                });
            });
        });
        const btnRun = q("#dn-run");
        if (btnRun) btnRun.addEventListener("click", () => {
            this.runAll({silent: false}).catch((e) => msg("重排失败：" + e.message, 8000, "error"));
            dlg.destroy();
        });
        const btnUndo = q("#dn-undo");
        if (btnUndo) btnUndo.addEventListener("click", () => {
            this.undoNumbering().catch((e) => msg("撤销失败：" + e.message, 8000, "error"));
            dlg.destroy();
        });
        /* 正文标题编号：开关 / 模板 / 实时预览 / 保存 / 恢复 / 撤销（v0.5.0） */
        const cbBodyEn = q("#dn-bodyen");
        if (cbBodyEn) cbBodyEn.addEventListener("change", (e) => {
            cfg.bodyEnabled = e.target.checked;
            this.saveConfig();
        });
        const cbBodyAuto = q("#dn-bodyauto");
        if (cbBodyAuto) cbBodyAuto.addEventListener("change", (e) => {
            cfg.bodyAuto = e.target.checked;
            if (e.target.checked) this.resetBodyTrip();   // 重新开启 = 复位熔断
            this.saveConfig();
        });
        const bInputs = [1, 2, 3, 4, 5].map((lv) => q("#dn-bf" + lv));
        const bPreview = q("#dn-bpreview");
        const paintBodyPreview = () => {
            if (!bPreview) return;
            const t = {};
            bInputs.forEach((el, i) => { t[i + 1] = el ? el.value : ""; });
            const fmts = BN.normalizeBodyFormats(t);
            /* 示例文档取「第2.1节」，于是 fn1=2、fn2=1 —— 与文档标题预览同一套号，
             * 用户能直接看出两处是怎么拼起来的（v0.8.5：fnK 只取第 K 级那一段）。 */
            const fnDemo = [, 2, 1];
            const core1 = String(fmts[1]).replace(/\s*\{title\}/g, "");
            const hn1 = [, 1];
            const r1 = BN.renderBodyTemplate(core1, 1,
                {prefix: "2.1", n: "1", h1: "", cn: "①", title: "", fn: fnDemo, hn: hn1});
            const samples = {1: "取样方法", 2: "样品处理", 3: "要点", 4: "备注", 5: "细节"};
            const hnDemo = [, 1, 1, 1, 1, 1];   // 预览取「第一小节」的样子，序号统一从 1 起
            bPreview.innerHTML = [1, 2, 3, 4, 5].map((lv) => {
                const fmt = String(fmts[lv]);
                const ctx = {prefix: "2.1", n: String(hnDemo[lv] || 1), h1: r1,
                             cn: BN.circled(hnDemo[lv] || 1), title: samples[lv],
                             fn: fnDemo, hn: hnDemo};
                const num = BN.renderBodyTemplate(fmt, lv, ctx);
                const hasTitle = /\{title\}/.test(fmt);
                const shown = hasTitle ? num
                    : num + (/\d$/.test(num.trimEnd()) ? " " : "") + samples[lv];
                return "<div><span class='dn-pv__lv'>" + lv + "级 →</span> <b>"
                    + escHtml(shown) + "</b></div>";
            }).join("");
        };
        bInputs.forEach((el) => { if (el) el.addEventListener("input", paintBodyPreview); });
        paintBodyPreview();
        const btnBUndo = q("#dn-bundo");
        if (btnBUndo) btnBUndo.addEventListener("click", () => {
            this.undoBodyNumbering()
                .catch((e) => msg("撤销失败：" + e.message, 8000, "error"));
            dlg.destroy();
        });
        /* 「现在编」两步走：第一次只算并报数，第二次才写库（写前存整批撤销快照）。
         * 面板里不用模态确认框，避免再叠一层对话框。 */
        const btnBRun = q("#dn-brun");
        if (btnBRun) btnBRun.addEventListener("click", async () => {
            const armed = this._bodyRunArmed;
            btnBRun.disabled = true;
            try {
                if (armed && Date.now() - armed.ts < 60000) {
                    this._bodyRunArmed = null;
                    btnBRun.textContent = "正在写…";
                    const r = await this.numberBodyRange(armed.ids, {source: "panel"});
                    btnBRun.textContent = "现在编";
                    msg(r.ok ? ("已给 " + r.docsHit + " 篇、共 " + r.changed + " 处正文标题编号")
                                     : ("批量编号中断，已改 " + r.changed + " 处，可点「撤销上次正文编号」回退"),
                                r.ok ? 6000 : 9000, r.ok ? "info" : "error");
                    this.refreshTopBar();
                    return;
                }
                const ids = await this.rangeDocIds();
                if (!ids.length) {
                    msg("还没有设置自动编号范围，先在上面「自动编号范围」里添加文档或笔记本", 7000, "info");
                    return;
                }
                const pre = await this.numberBodyRange(ids, {dryRun: true});
                if (!pre.total) {
                    msg("范围内 " + ids.length + " 篇的正文编号已是最新，无需改动", 6000, "info");
                    return;
                }
                this._bodyRunArmed = {ids: ids, ts: Date.now()};
                btnBRun.textContent = "确认写入 " + pre.total + " 处";
                msg("预检：" + pre.docsHit + " 篇、共 " + pre.total
                            + " 处标题要改。确认无误再点一次按钮写入（可整批撤销）", 10000, "info");
            } catch (e) {
                msg("正文批量编号失败：" + e.message, 9000, "error");
                btnBRun.textContent = "现在编";
            } finally {
                btnBRun.disabled = false;
            }
        });
        const btnClose = q("#dn-close");
        if (btnClose) btnClose.addEventListener("click", () => dlg.destroy());
    }

    /* ---------------- 采集：纯文件树递归（Q7） ---------------- */

    /** 文档范围：一次 SQL 只查根文档这一行，拿 box 与 ID 路径；其余全走文件树，避开索引滞后。 */
    async rootInfoForDoc(rootId) {
        for (let i = 0; i < 8; i++) {
            const rows = await sql("SELECT id, content, box, path FROM blocks WHERE id='" + esc(rootId) + "' LIMIT 1");
            if (rows && rows[0]) return rows[0];
            await sleep(400);
        }
        throw new Error("找不到这篇文档（可能刚新建，索引还没跟上）");
    }

    /**
     * 按 listDocsByPath 一层层展开，children 顺序 = 文档树自定义排序，title = 实时 name。
     * target: {type:"doc"|"notebook", id, box?, name}
     */
    async collect(target, opt) {
        const t = typeof target === "string" ? {type: "doc", id: target} : target;
        // pruneIds：这些文档节点本身仍参与本范围编号，但它们的子文档归更具体的文档范围管
        const pruneIds = new Set((opt && opt.pruneIds) || []);
        let root, box;
        if (t.type === "notebook") {
            box = t.id;
            root = {
                id: "__notebook__" + box, title: t.name || box,
                path: "/.sy",            // pathForList("/.sy") === "/"
                children: [], order: null, subFileCount: 1,
            };
        } else {
            const info = await this.rootInfoForDoc(t.id);
            box = t.box || info.box;
            root = {
                id: info.id, title: info.content || "", path: info.path,
                children: [], order: null, subFileCount: 1,
            };
        }

        /* v0.8.0：一次 SQL 把所有文档的属性编号读进来（blocks.ial 里是 `{: custom-doc-num="3"}` 这种），
         * 比逐篇 getBlockAttrs 快得多，也是「正文编号只认属性」的数据来源。 */
        const numMap = new Map();
        let numRows = null;
        /* v0.8.7：属性读取失败不能静默当「全都没属性」（会让正文编号回退标题识别、
         * 写出错误前缀）。有限重试后仍失败 → 抛错，本轮整范围跳过、不写库。 */
        for (let attempt = 0; attempt <= NUMMAP_RETRY; attempt++) {
            try {
                numRows = await sql("SELECT id, ial FROM blocks WHERE type='d' AND box='"
                                    + esc(box) + "' LIMIT 5000");
                break;
            } catch (e) {
                if (attempt === NUMMAP_RETRY) {
                    throw new Error("文档编号属性读取失败，本范围已跳过：" + e.message);
                }
                await sleep(200);
            }
        }
        (numRows || []).forEach((r) => {
            const ial = String(r.ial || "");
            const m = /custom-doc-num="([^"]*)"/.exec(ial);
            const pm = /custom-doc-pad="([^"]*)"/.exec(ial);
            /* v0.8.9：同一次 ial 里顺带把 JSON 元数据解析出来，零额外请求。 */
            const meta = DN.parseIalMeta(ial);
            if (!m && !meta) return;
            numMap.set(r.id, {
                num: m ? m[1] : "",
                pad: pm ? (Number(pm[1]) || 0) : 0,
                meta: meta,
            });
        });

        const orders = {};
        const names = {};
        const queue = [root];
        const failed = [];
        let visited = 0;
        /* v0.8.7：逐层并发拉目录。原来 while+shift 一次一个 await，157 个目录 ≈1.1s；
         * 现在每层最多 DIR_CONCURRENCY 路，结果按节点归位，顺序由 childrenFromFiles/order 决定，
         * 不依赖请求返回先后。 */
        while (queue.length && visited < MAX_NODES) {
            const layer = queue.splice(0, queue.length);
            const jobs = layer.map((node) => async () => {
                const listPath = DN.pathForList(node.path);
                let files = null, err = null;
                for (let attempt = 0; attempt <= DIR_RETRY; attempt++) {
                    try {
                        const d = await api("/api/filetree/listDocsByPath", {notebook: box, path: listPath});
                        files = (d && d.files) || [];
                        err = null;
                        break;
                    } catch (e) {
                        err = e;
                        if (attempt < DIR_RETRY) await sleep(120);
                    }
                }
                return {node, listPath, files, err};
            });
            const results = await mapLimit(jobs, DIR_CONCURRENCY, (fn) => fn());
            for (const r of results) {
                visited++;
                /* v0.8.7：读失败绝不静默当「没有子文档」——那会让指纹突变，
                 * 甚至按缺子树算出错误编号（与标题读失败不拿 SQL 兜底同一条铁律）。 */
                if (r.err || !r.files) {
                    failed.push(r.listPath + "：" + ((r.err && r.err.message) || "读取失败"));
                    continue;
                }
                const node = r.node;
                const listPath = r.listPath;
                const made = DN.childrenFromFiles(node.path, r.files);
                node.children = made.children;
                node.order = made.order;
                // 与 filetreeSortChanged 的 parentPath 同口径：笔记本根是 "/"，文档是 ID 路径
                orders[listPath] = made.order;
                made.children.forEach((c) => {
                    names[c.id] = c.title;
                    const rec = numMap.get(c.id);
                    if (rec) { c.num = rec.num; c.pad = rec.pad; c.meta = rec.meta; }
                });

                // 拖动刚发生时，内核缓存可能还没刷新；事件自带的 childIDs 就是用户拖出的新顺序
                const fresh = this._pendingOrders[listPath];
                if (fresh && Date.now() - fresh.ts < SORT_ORDER_TTL) {
                    node.order = fresh.ids.slice();
                    orders[listPath] = node.order.slice();
                    // 让 children 也按新顺序排，指纹和 buildPlan 才一致
                    node.children = DN.orderChildren(node.children, node.order);
                }

                // 只有 subFileCount > 0 的才是「目录」，叶子调接口会报错
                node.children.forEach((c) => {
                    // 该文档同时是另一个「文档范围」的根：只保留节点自身，不下钻子树，
                    // 避免两套层级口径轮流改写同一批文档（v0.4.1 修「标题一直闪烁」）。
                    if (pruneIds.has(c.id)) { c.children = []; return; }
                    if (c.subFileCount > 0 && queue.length + visited < MAX_NODES) queue.push(c);
                });
            }
        }
        if (failed.length) {
            throw new Error("文档树目录读取失败 " + failed.length + " 处，本轮不写入："
                            + failed.slice(0, 3).join("；"));
        }
        return {info: {id: root.id, content: root.title, box}, tree: root, orders, names, count: visited};
    }

    /* ---------------- 编号 / 撤销 ---------------- */

    async runNumbering(target, opt) {
        const o = opt || {};
        const t = typeof target === "string" ? {type: "doc", id: target} : target;
        if (!t || !t.id || (t.type === "doc" && !ID_RE.test(t.id))) throw new Error("文档 ID 不合法");
        /* v0.8.7：忙时排队，不再抛错。改前实测（e2e_stability S06）：两次并发入口
         * 有一个报「上一轮编号还在跑」；自动检查里这错误被 catch 吞掉 → 该范围静默漏编。 */
        if (this._runningPromise) {
            try { await this._runningPromise; } catch (e) { /* 上一轮失败不影响本轮 */ }
        }
        let release;
        const myLock = new Promise((r) => { release = r; });
        this._runningPromise = myLock;
        this._running = true;
        try {
            const cfg = this._config || DEFAULT_CONFIG;
            /* v0.8.7：autoCheck 已采过一次树时直接复用，省掉一整轮目录请求（S07）。 */
            const snap = o.snapshot || await this.collect(t, {pruneIds: ownedDocIds(cfg, t)});
            const {info, tree, orders} = snap;
            const excluded = Array.isArray(cfg.excluded) ? cfg.excluded : [];
            const spec = specForTarget(cfg, t);
            const plan = DN.buildPlan(tree, {
                skipPlaceholder: cfg.skipUntitled,
                skipIds: excluded.filter((e) => e.mode === "self").map((e) => e.id),
                skipSubtreeIds: excluded.filter((e) => e.mode === "subtree").map((e) => e.id),
                formats: spec.formats,
                counters: spec.counters,
                maxLevel: spec.maxLevel,
                stripFormats: stripListFor(cfg, t),
                writeAttrs: true,          // v0.8.0：顺手把编号写进文档属性
                emitMeta: true,            // v0.8.9：plan 带出完整链 / 本级序号 / path
            });
            const result = {
                rootId: t.id, rootTitle: info.content, box: info.box,
                counted: (tree.children || []).length,
                plan, changed: 0, failed: [], orders,
                verified: false, undoWritten: false,
            };
            /* v0.7.6：只算不写。用于「先看要改哪几篇」的预检（事故排查时必须有这个，
             * 否则只能靠真写一遍才知道对不对）。 */
            if (o.dryRun) {
                result.dryRun = true;
                result.wouldChange = plan.length;
                return result;
            }
            if (!plan.length) {
                if (!o.silent) msg("「" + info.content + "」下的子文档编号已是最新的，无需改动", 6000, "info");
                result.verified = true;
                return result;
            }

            // 备份：改名只动标题（实测不碰正文、不换 ID），记下旧标题即可完整回退。
            // API 写入不进思源 Ctrl+Z 撤销栈，撤销必须自带。
            await this.saveData(UNDO_FILE, JSON.stringify({
                time: new Date().toISOString(),
                source: o.source || "manual",
                rootId: t.id, rootTitle: info.content,
                changes: plan.map((p) => ({id: p.id, from: p.from, to: p.to})),
            }, null, 2));
            result.undoWritten = true;

            for (const p of plan) {
                try {
                    /* attrOnly：标题已经对了，只是属性缺/过期 → 不改名，只补属性 */
                    if (!p.attrOnly && p.to !== p.from) {
                        await api("/api/filetree/renameDocByID", {id: p.id, title: p.to});
                        result.changed++;
                    }
                    /* v0.8.9：rootID = 顶级文档；notebook 范围下取 path 第一段。
                     * rootNum = 祖先链编号，不含同级/其它分支。 */
                    const rootID = (t.type === "notebook") ? DN.topDocIdOf(p.path) : t.id;
                    const meta = DN.docNumMeta(rootID, p.chain, t.id);
                    await this.writeDocNumAttr(p.id, p.num, p.pad, meta);
                    if (p.attrOnly) result.attrOnly = (result.attrOnly || 0) + 1;
                } catch (e) {
                    result.failed.push({id: p.id, title: p.to, error: e.message});
                    break;   // 不继续改后面的，避免半套编号；撤销可回到改名前
                }
            }

            // 回读校验：先看实时文件树（无索引延迟），再用 SQL 兜一轮
            if (result.changed && !result.failed.length) {
                const want = new Map(plan.map((p) => [p.id, p.to]));
                for (let i = 0; i < VERIFY_ROUNDS; i++) {
                    const after = await this.collect(t);
                    let all = 0, hit = 0;
                    (function walk(n) {
                        (n.children || []).forEach((c) => {
                            if (want.has(c.id)) { all++; if (c.title === want.get(c.id)) hit++; }
                            walk(c);
                        });
                    })(after.tree);
                    if (all === want.size && hit === all) { result.verified = true; break; }
                    await sleep(350);
                }
            } else if (!result.changed) {
                result.verified = true;
            }

            /* v0.6.0 联动：文档被树编号改名 → 标题里的节号/章号变了，正文编号前缀要跟着刷新。
             * 只排被改名的那些文档，队列在防抖后由 bodyAutoCheck 消化。 */
            if (cfg.bodyAuto === true && result.changed) {
                this.scheduleBodyDocs(plan.map((p) => ({id: p.id, title: p.to})));
            }

            if (!o.silent) {
                if (result.failed.length) {
                    msg("编号中断：已改 " + result.changed + " 篇，失败 1 篇（" + result.failed[0].error
                        + "）。右键「撤销上次子文档编号」可回退", 10000, "error");
                } else if (!result.verified) {
                    msg("已提交 " + result.changed + " 处改名，但回读校验超时，请刷新文档树确认", 9000, "error");
                } else {
                    msg("已给「" + info.content + "」下 " + result.changed
                        + " 篇子文档编号；右键「撤销上次子文档编号」可回退", 8000, "info");
                }
            }
            return result;
        } finally {
            this._running = false;
            if (this._runningPromise === myLock) this._runningPromise = null;
            release();
        }
    }

    async runAll(opt) {
        const o = opt || {};
        const cfg = await this.getConfig();
        const out = [];
        let changed = 0;
        for (const t of cfg.targets) {
            try {
                // 内层静默：一次「全部重排」只弹一条汇总，不刷屏
                const r = await this.runNumbering(t, Object.assign({}, o, {silent: true}));
                out.push(r);
                changed += Number(r.changed) || 0;
            } catch (e) { out.push({rootId: t.id, error: e.message}); }
        }
        /* v0.8.9：顺带把范围元数据补齐（一次批量写，不改标题、不查范围外）。 */
        let meta = null;
        try { meta = await this.syncScopeMeta({}); }
        catch (e) { meta = {ok: false, error: e.message}; }
        /* v0.6.2（Q21，2026-11-07 16:43 用户要求）：「立即全部重排」不只改文档标题，
         * 顺带把范围内每一篇的正文标题也编一遍。正文功能被关掉（bodyEnabled=false）时不跑，
         * 免得关了正文编号还被改正文。 */
        let body = null;
        if (cfg.bodyEnabled !== false) {
            try {
                const ids = await this.rangeDocIds();
                if (ids.length) body = await this.numberBodyRange(ids, {source: "runAll", silent: true});
            } catch (e) { body = {ok: false, error: e.message}; }
        }
        const failed = out.filter((r) => r && (r.error || (r.failed && r.failed.length)));
        if (!o.silent) {
            if (failed.length) {
                const f = failed[0];
                msg("重排中断：" + (f.error || (f.failed[0] || {}).error || "未知错误")
                            + "。右键「撤销上次子文档编号」可回退", 10000, "error");
            } else {
                const bt = body
                    ? (body.ok ? "；正文 " + (body.docsHit || 0) + " 篇、" + (body.changed || 0) + " 处"
                               : "；正文失败：" + (body.error || ""))
                    : "；正文编号已关闭，只重排了文档标题";
                msg("文档树已重排 " + out.length + " 个范围、改 " + changed + " 个标题" + bt, 9000, "info");
            }
        }
        return {tree: out, body: body, meta: meta, changed: changed};
    }

    async undoNumbering(opt) {
        const o = opt || {};
        const raw = await this.loadData(UNDO_FILE);
        if (!raw) {
            if (!o.silent) msg("没有可撤销的上一轮编号", 5000, "info");
            return {ok: false, reason: "no-undo"};
        }
        let snap;
        try { snap = typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch (e) { throw new Error("撤销记录读不出来：" + e.message); }
        const changes = (snap && snap.changes) || [];
        let done = 0;
        const failed = [];
        for (let i = changes.length - 1; i >= 0; i--) {
            const c = changes[i];
            try {
                await api("/api/filetree/renameDocByID", {id: c.id, title: c.from});
                done++;
            } catch (e) {
                failed.push({id: c.id, error: e.message});
            }
        }
        let paused = false;
        /* v0.6.0 联动：标题被还原（节号变了）→ 正文前缀跟着刷新；
         * 树自动编号按原逻辑暂停，正文自动重算不受树暂停影响。 */
        if (done) {
            const cfgx = await this.getConfig();
            if (cfgx.bodyAuto === true) {
                this.scheduleBodyDocs(changes.map((c) => ({id: c.id, title: c.from})));
            }
        }
        if (!failed.length) {
            await this.removeData(UNDO_FILE);
            /* 撤销是用户明确表态「不要这轮编号」。若自动编号还开着，撤销自己发出的
             * rename 事件会在 1.5s 后把编号原样写回去 → 撤销成功即暂停自动编号。 */
            const cfg = await this.getConfig();
            if (cfg.enabled && !o.keepAuto) {
                cfg.enabled = false;
                await this.saveConfig();
                this.refreshTopBar();
                paused = true;
            }
        }
        this._fp = {};
        if (!o.silent) {
            msg((failed.length
                ? ("撤销完成 " + done + " 篇，失败 " + failed.length + " 篇，撤销记录已保留")
                : ("已撤销上一轮编号，恢复 " + done + " 篇原标题"))
                + (paused ? "；已暂停自动编号，需要时到顶栏面板重新启用" : ""), 8000,
                failed.length ? "error" : "info");
        }
        return {ok: !failed.length, done, failed, paused};
    }

    /* ---------------- 正文标题编号（v0.5.0） ---------------- */

    /** 渲染进程取光标所在块 ID 与实时文档标题（SQL 对标题也有索引滞后，DOM 最准）。 */
    currentBodyContext() {
        if (typeof document === "undefined" || typeof window === "undefined") return null;
        const sel = window.getSelection && window.getSelection();
        let el = sel && sel.anchorNode;
        if (el && el.nodeType === 3) el = el.parentElement;
        if (!el || !el.closest) return null;
        const node = el.closest("[data-node-id]");
        if (!node || !node.closest(".protyle-wysiwyg")) return null;
        const protyle = el.closest(".protyle");
        const titleEl = (protyle || document).querySelector(".protyle-title__input");
        return {
            blockId: node.getAttribute("data-node-id"),
            docTitle: titleEl ? String(titleEl.textContent || titleEl.value || "").trim() : "",
        };
    }

    /** 按 getChildBlocks 的真实顺序收集正文块；SQL 只补 subtype/content（顺序不可信）。 */
    async collectBodyBlocks(docId) {
        const rows = await sql("SELECT id, type, subtype, content FROM blocks WHERE root_id='"
                               + esc(docId) + "'");
        const meta = new Map(rows.map((r) => [r.id, r]));
        const out = [];
        const seen = new Set();
        const walk = async (pid, depth) => {
            if (depth > 8) return;
            /* 超出上限时置标记：静默截断会让「后半篇不编号」看起来像 bug（2026-11-07 审查） */
            if (out.length > 2000) { out.truncated = true; return; }
            let kids = [];
            try {
                const d = await api("/api/block/getChildBlocks", {id: pid});
                /* api() 返回的已经是 data 本体（数组），不能再取 .data ——
                 * v0.5.0 首版就是在这里双重解包，整篇正文读到 0 个块（2026-11-07 真机教训） */
                kids = Array.isArray(d) ? d : ((d && d.data) || []);
            } catch (e) { return; }
            for (const k of kids) {
                const id = k && k.id;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const m = meta.get(id) || {};
                const hm = /^h([1-6])$/.exec(String(m.subtype || k.subtype || ""));
                const tp = String(m.type || k.type || "");
                out.push({id: id, level: hm ? Number(hm[1]) : 0,
                          content: String(m.content || k.content || "")});
                // 只对容器块下钻；标题 / 段落没有子块
                if (tp === "l" || tp === "b" || tp === "s" || tp === "t" || tp === "html") {
                    await walk(id, depth + 1);
                }
            }
        };
        await walk(docId, 0);
        return out;
    }

    /** 逐块读实时 kramdown（去掉 `{: id=…}` 属性行）。
     *  标题块读不到 → 值为 **null**（「本轮不确定」），由调用方整篇跳过；段落块不影响编号，用 SQL content。
     *  v0.7.5 审查改了三点：
     *    ① 不再拿 SQL 的 content 兜底标题块 —— 那是索引滞后值，写回去等于把用户刚改的标题覆盖成旧的
     *       （与 v0.5.0「标题被清空」同一类事故）；
     *    ② 加并发上限（默认 8）：老实现 Promise.all 会对 200 块的文档同时发 200 个请求，容易把内核压住；
     *    ③ 顺序无关（结果进 Map），但并发池保证不会一次性打满。 */
    async bodyMarkdowns(blocks, opt) {
        const o = opt || {};
        const list = blocks || [];
        const limit = Math.max(1, Math.min(Number(o.concurrency) || 8, list.length || 1));
        const out = new Map();
        let cursor = 0;
        const worker = async () => {
            while (cursor < list.length) {
                const b = list[cursor++];
                let md = "";
                try {
                    const d = await api("/api/block/getBlockKramdown", {id: b.id});
                    /* api() 返回的已经是 data 本体（{id, kramdown}），不能再取 .data ——
                     * v0.5.0 首版在这里双重解包，所有块的 kramdown 都读成空（2026-11-07 真机教训） */
                    md = cleanKramdown(d && (d.kramdown != null ? d.kramdown
                        : (d.data && d.data.kramdown)));
                } catch (e) { /* 下面按「读不到」处理 */ }
                if (md.trim()) out.set(b.id, md);
                else out.set(b.id, b.level ? null : String(b.content || ""));
            }
        };
        await Promise.all(new Array(limit).fill(0).map(worker));
        return out;
    }

    /**
     * 快捷键 Ctrl+Alt+N：把光标所在段落设为第 N 级标题，再级联重算整篇标题编号。
     * opt.context 可注入 {blockId, docTitle} 供真机验证复用同一条链路。
     */
    async numberBodyAtCursor(level, opt) {
        const o = opt || {};
        const lv = Math.max(1, Math.min(BN.LEVEL_MAX, Number(level) || 1));
        const cfg = this._config || DEFAULT_CONFIG;
        if (cfg.bodyEnabled === false) {
            if (!o.silent) msg("正文编号快捷键已在设置里关闭", 6000, "info");
            return {ok: false, reason: "disabled"};
        }
        const ctx = o.context || this.currentBodyContext();
        if (!ctx || !ctx.blockId) {
            if (!o.silent) msg("请把光标放到正文段落里再按快捷键", 6000, "info");
            return {ok: false, reason: "no-cursor"};
        }
        const rows = await sql("SELECT root_id FROM blocks WHERE id='" + esc(ctx.blockId) + "' LIMIT 1");
        if (!rows.length || !rows[0].root_id) return {ok: false, reason: "no-doc"};
        const docId = rows[0].root_id;
        /* 光标落在编辑器根节点上（closest 拿到的是文档 ID）：绝不把 updateBlock 打到文档根 */
        if (ctx.blockId === docId) {
            if (!o.silent) msg("光标不在正文段落里，请点到具体段落再按快捷键", 6000, "info");
            return {ok: false, reason: "doc-root"};
        }
        let docTitle = String(ctx.docTitle || "");
        if (!docTitle) {
            const t = await sql("SELECT content FROM blocks WHERE id='" + esc(docId) + "' LIMIT 1");
            docTitle = t.length ? String(t[0].content || "") : "";
        }
        const ordered = await this.collectBodyBlocks(docId);
        if (!ordered.some((b) => b.id === ctx.blockId)) {
            // 刚新建的块可能还没进 SQL 索引：补进去，避免按了没反应
            ordered.unshift({id: ctx.blockId, level: 0, content: ""});
        }
        const mdMap = await this.bodyMarkdowns(ordered);
        /* 安全闸：当前段落的文字读不上来（瞬时空读 / 未提交），宁可不编号也绝不能拿空串覆盖标题 */
        const focusMd = mdMap.get(ctx.blockId) || "";
        if (!focusMd.trim()) {
            if (!o.silent) msg("读不到当前段落的文字，未做任何改动，请把光标移回正文再试", 7000, "info");
            return {ok: false, reason: "empty-read", docId: docId, docTitle: docTitle};
        }
        /* 其它标题块读不到同样整篇跳过：否则它们不占号，后面标题会整体前移，下一轮又改回来 */
        const unread2 = ordered.filter((b) => mdMap.get(b.id) === null);
        if (unread2.length) {
            if (!o.silent) msg("有 " + unread2.length + " 个标题块暂时读不到内容，"
                + "为避免编号错乱，本次未做改动，请稍后再试", 8000, "info");
            return {ok: false, reason: "read-failed", docId: docId, unread: unread2.length};
        }
        const blocks = ordered.map((b) => ({id: b.id, level: b.level, markdown: mdMap.get(b.id) || ""}));
        /* 新块 SQL 未就绪时 level 读成 0：从实时 kramdown 的 # 数兜底推导（与 numberBodyDoc 同款） */
        blocks.forEach((b) => {
            if (!b.level) {
                const hm = /^\s{0,3}(#{1,6})\s/.exec(String(b.markdown || ""));
                if (hm) b.level = hm[1].length;
            }
        });
        /* 正文模板：当前 → 上次 → 内置，都进剥旧号候选；渲染只用当前一套 */
        const bodyFmt = cfg.bodyFormats ? BN.normalizeBodyFormats(cfg.bodyFormats)
                                        : BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS);
        const stripFmts = bodyStripList(cfg, bodyFmt);
        const numAttr2 = await this.readDocNumAttr(docId);
        const r = BN.buildBodyPlan({docTitle: docTitle, blocks: blocks,
                                    docNum: numAttr2.num, docNumPad: numAttr2.pad,
                                    focus: {id: ctx.blockId, level: lv},
                                    formats: bodyFmt, stripFormats: stripFmts,
                                    normalizeDepth: true});
        if (r.reason === "no-prefix") {
            if (!o.silent) msg("当前文档标题里没有节编号或章编号，已跳过正文编号", 7000, "info");
            return {ok: false, reason: "no-prefix", docId: docId, docTitle: docTitle};
        }
        if (!r.plan.length) {
            if (!o.silent) msg("正文标题编号已是最新，无需改动", 6000, "info");
            return {ok: true, changed: 0, prefix: r.prefix, docId: docId, plan: []};
        }

        // API 写入不进思源 Ctrl+Z：逐块记下旧 markdown，供「撤销上次正文编号」还原
        await this.saveData(BODY_UNDO_FILE, JSON.stringify({
            time: new Date().toISOString(), docId: docId, docTitle: docTitle, level: lv,
            changes: r.plan.map((p) => ({id: p.id, from: p.from, to: p.to})),
        }, null, 2));
        const failed = [];
        let changed = 0;
        for (const p of r.plan) {
            try {
                await api("/api/block/updateBlock", {id: p.id, dataType: "markdown", data: p.to});
                changed++;
            } catch (e) {
                failed.push({id: p.id, error: e.message});
                break;
            }
        }
        if (!o.silent) {
            if (failed.length) {
                msg("正文编号中断：已改 " + changed + " 处，可用「撤销上次正文编号」回退", 9000, "error");
            } else {
                msg("已把当前段落设为 " + lv + " 级标题，并重排 " + changed + " 处正文编号", 7000, "info");
            }
        }
        return {ok: !failed.length, changed: changed, prefix: r.prefix, prefixKind: r.prefixKind,
                docId: docId, docTitle: docTitle, plan: r.plan, failed: failed};
    }

    /* 正文编号模板：只写设置、不重写任何文档；换模板时把上一套存进 bodyLastFormats 供剥旧号。
     * 与内置默认完全一致的模板按「没自定义」处理（存 null），保持配置干净。 */
    async saveBodyFormats(spec) {
        const cfg = await this.getConfig();
        const norm = BN.normalizeBodyFormats(spec);
        const bad = badPlaceholders(norm);
        if (bad.length) {
            throw new Error("模板里有不认识的占位符：" + bad.join("、")
                + "。可用的只有 {fn1}~{fn5}、{hn1}~{hn5}、{fn}、{hn}、{title}、{n}、{nn}、"
                + "{parentN}、{parentNN}、{prefix}、{h1}、{cn}（可带 :cn/:CN/:a/:o/:i/:03 格式）");
        }
        const builtin = BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS);
        const isBuiltin = [1, 2, 3, 4, 5].every((lv) => norm[lv] === builtin[lv]);
        if (cfg.bodyFormats) cfg.bodyLastFormats = BN.normalizeBodyFormats(cfg.bodyFormats);
        /* v0.8.2：正文模板也留多份历史 —— 换过两次以后，第一套形态的老号同样要能剥 */
        if (cfg.bodyFormats) {
            const hist = Array.isArray(cfg.bodyFormatsHistory) ? cfg.bodyFormatsHistory.slice() : [];
            const sig = JSON.stringify(BN.normalizeBodyFormats(cfg.bodyFormats));
            if (!hist.some((f) => JSON.stringify(BN.normalizeBodyFormats(f)) === sig)) hist.push(cfg.bodyFormats);
            cfg.bodyFormatsHistory = hist.slice(-8);
        }
        const changed = JSON.stringify(norm) !== JSON.stringify(
            cfg.bodyFormats ? BN.normalizeBodyFormats(cfg.bodyFormats)
                            : BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS));
        cfg.bodyFormats = isBuiltin ? null : norm;
        await this.saveConfig();
        return {ok: true, changed: changed, bodyFormats: cfg.bodyFormats,
                bodyLastFormats: cfg.bodyLastFormats};
    }

    /**
     * 切换正文编号方案后自动重排（v0.8.2）。
     * 用户要求「切换编号前，应该自动剔除老编号」——所以换模板不能只存设置，
     * 必须现场把范围内所有文档的正文标题按「先剥老号、再套新模板」重写一遍。
     * 整批共用一份撤销快照（numberBodyRange 内部处理），失败会如实回报。
     */
    async rerunBodyForSwitch(opt) {
        const o = opt || {};
        const ids = await this.rangeDocIds();
        if (!ids.length) return {ok: true, total: 0, docsHit: 0, changed: 0};
        const r = await this.numberBodyRange(ids, {source: o.source || "format-switch",
                                                   silent: true});
        if (!o.silent) {
            msg(r.ok
                ? ("正文模板已切换：已按新模板重排 " + (r.docsHit || 0) + " 篇 / "
                   + (r.changed || 0) + " 处（老编号已剔除）")
                : ("正文重排中断：已改 " + (r.changed || 0) + " 处，可在面板撤销"),
                r.ok ? 8000 : 10000, r.ok ? "info" : "error");
        }
        return r;
    }

    async undoBodyNumbering(opt) {
        const o = opt || {};
        const raw = await this.loadData(BODY_UNDO_FILE);
        if (!raw) {
            if (!o.silent) msg("没有可撤销的上一轮正文编号", 5000, "info");
            return {ok: false, reason: "no-undo"};
        }
        let snap;
        try { snap = typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch (e) { throw new Error("正文撤销记录读不出来：" + e.message); }
        const changes = (snap && snap.changes) || [];
        let done = 0;
        const failed = [];
        let skippedEmpty = 0, skippedMissing = 0;
        /* v0.7.5：快照里的块可能已经不存在了（文档被删 / 测试留下的临时快照），
         * 直接 updateBlock 会一路报错、把记录留着、用户还不知道为什么。先一次性查存在性。 */
        const alive = new Set();
        try {
            const ids = changes.map((c) => c && c.id).filter((x) => x && ID_RE.test(String(x)));
            for (let k = 0; k < ids.length; k += 400) {
                const chunk = ids.slice(k, k + 400);
                const rows = await sql("SELECT id FROM blocks WHERE id IN ('" + chunk.join("','") + "')");
                (rows || []).forEach((r) => alive.add(r.id));
            }
        } catch (e) { /* 查不到就当作全在，退回旧行为 */ }
        for (let i = changes.length - 1; i >= 0; i--) {
            const c = changes[i];
            /* 原文为空的条目一律跳过：撤销的意义是还原文字，写空串只会再清一次标题 */
            if (!String(c.from == null ? "" : c.from).trim()) { skippedEmpty++; continue; }
            /* 块已不存在 → 跳过（不算失败）。history 快照可能来自已被删掉的临时文档 */
            if (alive.size && !alive.has(c.id)) { skippedMissing++; continue; }
            try {
                await api("/api/block/updateBlock", {id: c.id, dataType: "markdown", data: c.from});
                done++;
            } catch (e) { failed.push({id: c.id, error: e.message}); }
        }
        if (!failed.length) await this.removeData(BODY_UNDO_FILE);
        /* 撤销是用户明确表态「不要这轮编号」。正文自动重算若还开着，撤销写入的
         * savedoc 会在防抖后把编号原样写回去 → 撤销成功即暂停正文自动重算
         * （学树编号撤销暂停 cfg.enabled 的老规矩）。 */
        let pausedBody = false;
        /* done=0（全是空/已删记录）时不暂停：什么都没改，暂停只会让用户莫名其妙 */
        if (done && !failed.length && !o.keepAuto) {
            const cfgx = await this.getConfig();
            if (cfgx.bodyAuto === true) {
                cfgx.bodyAuto = false;
                await this.saveConfig();
                pausedBody = true;
            }
        }
        if (!o.silent) {
            const who = snap && snap.docTitle ? ("《" + snap.docTitle + "》") : "";
            msg(failed.length
                ? ("正文撤销完成 " + done + " 处，失败 " + failed.length + " 处，记录已保留")
                : ("已撤销" + who + "的上一轮正文编号，恢复 " + done + " 处原标题"
                   + (skippedEmpty ? ("（跳过 " + skippedEmpty + " 处原文为空的记录）") : "")
                   + (skippedMissing ? ("（跳过 " + skippedMissing + " 处已不存在的块）") : "")
                   + (pausedBody ? "；正文自动重算已暂停，需要时到面板重新开启" : "")), 8000,
                failed.length ? "error" : "info");
        }
        return {ok: !failed.length, done: done, skippedEmpty: skippedEmpty,
                skippedMissing: skippedMissing, pausedBody: pausedBody, failed: failed,
                snapshotDocId: snap && snap.docId ? snap.docId : null,
                snapshotDocTitle: snap && snap.docTitle ? snap.docTitle : null};
    }

    /* ---------------- 正文自动编号（v0.6.0） ---------------- */

    /**
     * savedoc 事件入口：探针实测 detail = {cmd, data:{rootID, sources:[{doOperations}...]}}
     * （rootID 在 detail.data 里，不在 detail 顶层——2026-11-07 E2E 第一轮就栽在这里）。
     * op.data 是 DOM 片段，廉价筛选：
     *   - 含 data-type="NodeHeading" → 标题块变了（插入 / 改文字 / 升降级全覆盖）；
     *   - delete op 的 data 为空，分不清删的是不是标题 → 只能整篇复核一轮（幂等，无变化不写）；
     *   - 其余操作（普通段落等）直接忽略，不进防抖队列。
     */
    onSaveDoc(d) {
        const cfg = this._config || DEFAULT_CONFIG;
        if (cfg.bodyAuto !== true) return;
        const pay = d && d.data && typeof d.data === "object" ? d.data : d;
        const docId = pay && pay.rootID;
        if (!docId || !ID_RE.test(String(docId))) return;
        const ops = [];
        (pay.sources || []).forEach((s) => {
            ((s && s.doOperations) || []).forEach((o) => ops.push(o));
        });
        if (!ops.length) return;
        let hit = false;
        for (const o of ops) {
            if (String(o.action || "") === "delete") { hit = true; break; }
            if (String(o.data || "").indexOf('data-type="NodeHeading"') >= 0) { hit = true; break; }
        }
        if (!hit) return;
        this.scheduleBodyDocs([docId]);
    }

    /** 把待复核文档排进防抖队列（savedoc、树改名联动、树撤销联动共用）。
     * 元素可以是 id 字符串，也可以是 {id, title}（联动方知道新标题，直传避免 SQL 索引滞后）。 */
    scheduleBodyDocs(ids) {
        const cfg = this._config || DEFAULT_CONFIG;
        if (cfg.bodyAuto !== true || !Array.isArray(ids) || !ids.length) return;
        if (!this._bodyPending) this._bodyPending = new Set();
        if (!this._bodyHints) this._bodyHints = {};
        ids.forEach((it) => {
            const id = it && it.id ? it.id : it;
            const title = it && it.id ? String(it.title || "") : "";
            if (id && ID_RE.test(String(id))) {
                this._bodyPending.add(id);
                if (title) this._bodyHints[id] = title;
            }
        });
        clearTimeout(this._bodyTimer);
        this._bodyTimer = setTimeout(() => {
            this.bodyAutoCheck().catch((e) => console.warn("[doc-num] 正文自动重算失败", e));
        }, Number(cfg.debounceMs) || 1500);
    }

    /** 防抖到点：逐篇「范围判定 → 整篇重算 → 幂等只写变化块 → 熔断检查」。 */
    async bodyAutoCheck(opt) {
        const o = opt || {};
        const cfg = this._config || DEFAULT_CONFIG;
        if (cfg.bodyAuto !== true || !this._bodyPending || !this._bodyPending.size) {
            return {ok: true, skipped: true, details: []};
        }
        /* v0.7.5：忙的时候不能「直接返回」就完事。
         * 老实现 busy 时 return，而 scheduleBodyDocs 的定时器已经烧掉了 ——
         * 队列里剩下的文档要等到用户下次保存才可能被处理（表现为「有的文档就是没编号」）。
         * 这里记一个再跑标记，finally 里补一轮。 */
        if (this._bodyBusy) {
            this._bodyPendingAgain = true;
            return {ok: true, busy: true, details: []};
        }
        const docs = Array.from(this._bodyPending);
        this._bodyPending.clear();
        if (!this._bodyOsc) this._bodyOsc = {};   // docId -> {sig, hits}，检测反复改写
        if (!this._bodyRetry) this._bodyRetry = {};
        this._bodyBusy = true;
        const details = [];
        try {
            for (const docId of docs) {
                try {
                    if (!await this.docInTargets(docId)) {
                        details.push({docId, reason: "out-of-scope"});
                        continue;
                    }
                    /* 熔断真的拦住（v0.7.3）：以前只记标记不检查，导致每次事件照写一遍、
                     * 每次再弹一次提示 —— 用户看到的就是「弹很多这样的信息」。 */
                    if (this._bodyTripped && this._bodyTripped[docId]) {
                        details.push({docId, reason: "tripped-skip"});
                        continue;
                    }
                    /* 联动入队的文档带着新标题（防 SQL 索引滞后读旧名 → 误判 no-prefix）。
                     * 取完立即删：老实现放在 finally 里按「本批 docs」批量删，会误删处理期间
                     * 新入队的同一篇文档的新 hint。 */
                    const hint = (this._bodyHints || {})[docId] || "";
                    if (this._bodyHints) delete this._bodyHints[docId];
                    const r = await this.numberBodyDoc(docId,
                        {silent: !cfg.notify, source: "auto", docTitle: hint});
                    if (r.ok) delete this._bodyRetry[docId];
                    details.push({docId, changed: r.changed || 0,
                                  reason: r.changed ? "renumbered" : (r.reason || "unchanged")});
                    /* 临时原因补有限重试：
                     *   read-failed = 内容读不到（索引未就绪，最可能自愈）
                     *   empty       = 文档在、但没有子块（刚建的文档可能还没索引到子块）
                     * 永久原因不重试：
                     *   no-prefix = 标题里本来就没有节/章号，重试一万次也不会有
                     *   no-doc    = 文档行都查不到（已删除），重试只会空转 —— 2026-11-07 审查发现
                     *               测试删掉的临时文档会因此反复入队，队列里躺一篇「查不到」的僵尸 */
                    if (!r.ok && ["read-failed", "empty"].indexOf(String(r.reason)) >= 0) {
                        this.queueBodyRetry(docId);
                    }
                    /* 熔断：同一批 from→to 连续 3 轮，说明另有口径把编号改回去了
                     * （学 v0.4.1 树编号闪烁的教训）。正常幂等轮次 plan 为空，不会连续重复。 */
                    if (r.changed) {
                        const sig = (r.plan || []).map((p) => p.id + ":" + p.from + ">" + p.to).join("|");
                        const prev = this._bodyOsc[docId];
                        const rec = {sig, hits: prev && prev.sig === sig ? prev.hits + 1 : 1};
                        this._bodyOsc[docId] = rec;
                        if (sig && rec.hits >= 3) {
                            if (!this._bodyTripped) this._bodyTripped = {};
                            this._bodyTripped[docId] = true;
                            /* 同一文档 10 分钟内只提示一次：熔断已经拦住改写，反复弹窗只会烦人 */
                            if (!this._bodyTripToast) this._bodyTripToast = {};
                            const last = this._bodyTripToast[docId] || 0;
                            if (Date.now() - last > 10 * 60 * 1000) {
                                this._bodyTripToast[docId] = Date.now();
                                msg("《" + (r.docTitle || docId) + "》的正文编号连续 3 轮都算出不同结果，"
                                    + "已暂停这篇的自动编号（其它文档不受影响）。多为标题只剩编号没有文字、"
                                    + "或模板里含格式导致号形不稳定；处理好后到面板把「内容标题变化后自动重算」"
                                    + "关一次再开即可恢复", 12000, "error");
                            }
                            details.push({docId, reason: "oscillation-stopped"});
                        }
                    } else {
                        delete this._bodyOsc[docId];
                    }
                } catch (e) {
                    details.push({docId, error: e.message});
                    this.queueBodyRetry(docId);
                }
            }
        } finally {
            (this._bodyLog = this._bodyLog || []).push({time: new Date().toISOString(), details});
            if (this._bodyLog.length > 60) this._bodyLog.shift();
            this._bodyBusy = false;
            /* 忙的时候被挡下的、以及临时失败重试的，都在这里补一轮 */
            if (this._bodyPendingAgain || (this._bodyPending && this._bodyPending.size)) {
                this._bodyPendingAgain = false;
                if (this._bodyPending && this._bodyPending.size) {
                    clearTimeout(this._bodyRetryTimer);
                    this._bodyRetryTimer = setTimeout(() => {
                        this.bodyAutoCheck().catch(() => {});
                    }, 400);
                }
            }
        }
        return {ok: true, details};
    }

    getBodyLog() {
        return (this._bodyLog || []).slice();
    }

    /**
     * 自检（v0.7.5）：只读，不写任何文档。返回逐项结果，用于排查「编号没生效 / 卡住 / 配置不对」。
     * 面板与真机脚本都调它，避免再靠猜。
     */
    async diagnose() {
        const cfg = await this.getConfig();
        const checks = [];
        const add = (name, ok, detail) => checks.push({name, ok: !!ok, detail: detail == null ? "" : String(detail)});

        /* 1 配置结构 */
        const fmtOk = cfg.defaultFormats && !Array.isArray(cfg.defaultFormats)
            && [1, 2, 3, 4, 5].every((lv) => typeof cfg.defaultFormats[lv] === "string" && cfg.defaultFormats[lv].trim());
        add("文档标题模板 1~5 级齐全", fmtOk, fmtOk ? cfg.defaultFormats[3] : JSON.stringify(cfg.defaultFormats));
        const bf = cfg.bodyFormats ? BN.normalizeBodyFormats(cfg.bodyFormats)
                                   : BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS);
        const bfOk = [1, 2, 3, 4, 5].every((lv) => String(bf[lv] || "").trim());
        add("内容标题模板 1~5 级齐全", bfOk, "1级=" + bf[1] + " 2级=" + bf[2]);

        /* 2 排除项 mode 合法 */
        const badEx = (cfg.excluded || []).filter((e) => e && e.mode && ["self", "subtree"].indexOf(e.mode) < 0);
        add("排除项模式合法（self / subtree）", badEx.length === 0,
            "共 " + (cfg.excluded || []).length + " 项" + (badEx.length ? "，异常 " + badEx.length : ""));

        /* 3 subOf 可用（历史 bug：subtree 排除因它未定义而静默失效） */
        let subOk = false, subDetail = "";
        try {
            const r0 = await sql("SELECT path FROM blocks WHERE type='d' LIMIT 1");
            const p0 = r0 && r0[0] ? String(r0[0].path || "") : "";
            subOk = typeof subOf === "function" && (!p0 || subOf(p0).slice(-3) !== ".sy");
            subDetail = p0 ? (p0 + " → " + subOf(p0)) : "（库里暂无文档）";
        } catch (e) { subDetail = e.message; }
        add("subtree 排除依赖的路径解析可用", subOk, subDetail);

        /* 4 范围展开 */
        let docIds = [];
        try { docIds = await this.rangeDocIds(); } catch (e) { /* 下面报 */ }
        add("编号范围能展开成文档列表", docIds.length > 0 || !(cfg.targets || []).length,
            (cfg.targets || []).length + " 个范围 → " + docIds.length + " 篇");

        /* 5 自动编号状态 */
        add("自动编号未被卡在忙状态", !this._bodyBusy && !this._autoBusy,
            "bodyBusy=" + !!this._bodyBusy + " autoBusy=" + !!this._autoBusy);
        const tripped = Object.keys(this._bodyTripped || {});
        add("无文档被熔断拦着", tripped.length === 0, tripped.length ? tripped.join(", ") : "无");
        /* 有待处理文档本身是正常的（正在防抖窗口里排队）。真正的不变量是：
         * 「有队列，但既没有定时器、也不在忙」= 没人会再来处理 → 才是卡住。
         * 2026-11-07 审查：老的自检把「pending>0」直接判失败，正常排队也被报成异常。 */
        const pending = this._bodyPending ? this._bodyPending.size : 0;
        const willRun = pending === 0 || !!this._bodyTimer || !!this._bodyRetryTimer
                        || !!this._bodyBusy || !!this._bodyPendingAgain;
        add("待处理队列有人接手", willRun,
            "待处理 " + pending + " 篇 · 定时器 " + (!!this._bodyTimer) + " · 忙 " + (!!this._bodyBusy));

        /* 6 撤销快照归属 */
        let snap = null;
        try {
            const raw = await this.loadData(BODY_UNDO_FILE);
            if (raw) snap = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) { /* 读不出就当没有 */ }
        add("撤销快照可读", true, snap
            ? ("《" + (snap.docTitle || (snap.docIds || []).length + " 篇") + "》，"
               + ((snap.changes || []).length) + " 处，" + (snap.time || ""))
            : "无");

        /* 7 笔记本缓存可用（右键菜单同步判断依赖它） */
        add("笔记本列表可读", Array.isArray(this._notebookCache), (this._notebookCache || []).length + " 本");

        return {ok: checks.every((c) => c.ok), version: PLUGIN_VERSION,
                config: {enabled: cfg.enabled, bodyEnabled: cfg.bodyEnabled !== false,
                         bodyAuto: cfg.bodyAuto === true, targets: (cfg.targets || []).length,
                         excluded: (cfg.excluded || []).length},
                checks: checks};
    }

    /** 临时性失败（读不到内容 / 索引未就绪）有限重试：最多 2 次，成功即清计数。
     *  永久性失败（no-prefix：文档标题里没有节/章号）不重试 —— 重试一万次也还是没有号。 */
    queueBodyRetry(docId) {
        if (!docId) return;
        if (!this._bodyRetry) this._bodyRetry = {};
        const n = this._bodyRetry[docId] || 0;
        if (n >= 2) { delete this._bodyRetry[docId]; return; }
        this._bodyRetry[docId] = n + 1;
        if (!this._bodyPending) this._bodyPending = new Set();
        this._bodyPending.add(docId);
    }

    /** 重新开启自动重算时清掉熔断记录（面板开关切换即复位）。 */
    resetBodyTrip() {
        this._bodyTripped = {};
        this._bodyOsc = {};
        this._bodyTripToast = {};
        this._bodyRetry = {};
        this._bodyPendingAgain = false;
        return true;
    }

    /**
     * 文档是否落在任一编号范围内。
     * doc 范围 = 该文档**及其全部子文档**（与树编号「右键文档管子文档」同口径，按 path 前缀判定）；
     * notebook 范围 = 比对 box。刚建的文档 SQL 可能未就绪，宁可判不在范围（下一轮事件补上）。
     */
    async docInTargets(docId) {
        const cfg = this._config || DEFAULT_CONFIG;
        const ts = Array.isArray(cfg.targets) ? cfg.targets : [];
        let docPath = null, docBox = null;
        const meta = async (id) => {
            const rows = await sql("SELECT box, path FROM blocks WHERE id='"
                                   + esc(id) + "' LIMIT 1");
            return rows && rows[0] ? rows[0] : null;
        };
        for (const t of ts) {
            if ((t.type || "doc") === "doc") {
                if (t.id === docId) return true;
                try {
                    if (docPath == null) {
                        const m = await meta(docId);
                        if (!m) return false;   // 文档刚删 / 索引未就绪
                        docPath = String(m.path || "");
                        docBox = m.box;
                    }
                    const p = await meta(t.id);
                    if (p && p.path && docPath) {
                        /* 实测（用户书稿验证）：子文档 path = /<父ID>/<子ID>.sy，父目录段不带 .sy
                         * （父自己的 path 才是 /<父ID>.sy）——前缀必须用去掉 .sy 的父 ID 段，
                         * 直接 startsWith(父path+"/") 会全军覆没（v0.6.0 E2E 测试 11 抓到）。 */
                        let base = String(p.path);
                        if (base.slice(-3) === ".sy") base = base.slice(0, -3);
                        if (docPath.startsWith(base + "/")) return true;
                    }
                } catch (e) { /* 继续看下一个范围 */ }
            } else {
                try {
                    if (docBox == null) {
                        const m = await meta(docId);
                        if (!m) return false;
                        docPath = String(m.path || "");
                        docBox = m.box;
                    }
                    if (docBox && docBox === t.id) return true;
                } catch (e) { /* 继续看下一个范围 */ }
            }
        }
        return false;
    }

    /**
     * 把「自动编号范围」展开成文档 ID 列表（v0.6.1，供批量正文编号用）。
     * doc 范围 = 该文档 + 全部子文档（path 前缀）；notebook 范围 = 该笔记本全部文档。
     * 排除项：self 去掉自身；subtree 去掉自身及其子文档。
     */
    async rangeDocIds() {
        const cfg = this._config || DEFAULT_CONFIG;
        const ts = Array.isArray(cfg.targets) ? cfg.targets : [];
        const ex = Array.isArray(cfg.excluded) ? cfg.excluded : [];
        const ids = new Set();
        for (const t of ts) {
            try {
                (await this.idsForTarget(t)).forEach((id) => ids.add(id));
            } catch (e) { /* 单个范围取不到就跳过，别整批失败 */ }
        }
        const drop = new Set();
        for (const e of ex) {
            if (!e || !e.id) continue;
            drop.add(e.id);
            if (e.mode !== "subtree") continue;
            try {
                const rows = await sql("SELECT path, box FROM blocks WHERE id='" + esc(e.id) + "' LIMIT 1");
                if (!rows.length) continue;
                const base = subOf(rows[0].path);
                const subs = await sql("SELECT id FROM blocks WHERE type='d' AND box='"
                                       + esc(rows[0].box) + "' AND path LIKE '" + esc(base) + "/%' LIMIT 3000");
                subs.forEach((r) => drop.add(r.id));
            } catch (e2) { /* 取不到就不额外剔除 */ }
        }
        return Array.from(ids).filter((id) => !drop.has(id));
    }

    /** 单个范围 → 该范围内的文档 ID 列表（doc 范围含全部子文档；notebook 范围含整本）。 */
    async idsForTarget(t) {
        const out = [];
        if (!t || !t.id) return out;
        if ((t.type || "doc") === "notebook") {
            const rows = await sql("SELECT id FROM blocks WHERE type='d' AND box='"
                                   + esc(t.id) + "' LIMIT 3000");
            (rows || []).forEach((r) => out.push(r.id));
            return out;
        }
        const info = await this.rootInfoForDoc(t.id);
        out.push(info.id);
        const base = subOf(info.path);
        const rows = await sql("SELECT id FROM blocks WHERE type='d' AND box='"
                               + esc(info.box) + "' AND path LIKE '" + esc(base) + "/%' LIMIT 3000");
        (rows || []).forEach((r) => out.push(r.id));
        return out;
    }

    /**
     * v0.8.8：把自动编号范围展开成**按文档树顺序**的文档清单，供 xref 多文档交叉引用复用。
     * 顺序来自 collect() 的 listDocsByPath 层级（同级 = 文档树自定义排序），
     * 不是 SQL 返回顺序、也不是 path 字符串排序 —— 拖拽排序只能靠它才不失真。
     * 每项 {id, title, num, pad, box, path, depth, target, meta}；meta 是 custom-doc-num-meta
     * 解析后的对象（v0.9.1 起只含 rootID / rootNum / targetId；历史文档可能多带 2 个旧字段，
     * 读的一方忽略即可），xref 可直接用，不必再查父文档。
     * 任一范围读取失败 → 整批抛错，调用方必须整批不写（v0.8.7 铁律）。
     */
    async rangeDocIdsOrdered(opt) {
        const o = opt || {};
        const cfg = this._config || DEFAULT_CONFIG;
        const ts = Array.isArray(cfg.targets) ? cfg.targets : [];
        const ex = Array.isArray(cfg.excluded) ? cfg.excluded : [];
        const exSelf = new Set(ex.filter((e) => e && e.id && e.mode !== "subtree").map((e) => e.id));
        const exTree = new Set(ex.filter((e) => e && e.id && e.mode === "subtree").map((e) => e.id));
        const limit = o.limit > 0 ? o.limit : MAX_NODES;
        const seen = new Set();
        const out = [];
        for (let ti = 0; ti < ts.length; ti++) {
            const t = ts[ti];
            if (!t || !t.id) continue;
            const snap = await this.collect(t, {pruneIds: ownedDocIds(cfg, t)});
            const box = snap.info.box;
            const walk = (node, depth, virtual) => {
                if (out.length >= limit) return;
                const id = String(node.id || "");
                if (!virtual && exTree.has(id)) return;   // subtree 排除：整枝不要
                if (!virtual && !exSelf.has(id) && ID_RE.test(id) && !seen.has(id)) {
                    seen.add(id);
                    out.push({
                        id: id,
                        title: String(node.title || snap.names[id] || ""),
                        num: node.num == null ? "" : String(node.num),
                        pad: node.pad == null ? 0 : (Number(node.pad) || 0),
                        box: box,
                        path: String(node.path || ""),
                        depth: depth,
                        target: ti,
                        meta: node.meta || null,
                    });
                }
                (node.children || []).forEach((c) => walk(c, depth + 1, false));
            };
            if ((t.type || "doc") === "notebook") walk(snap.tree, 0, true);
            else walk(snap.tree, 0, false);
        }
        return out;
    }

    /**
     * v0.8.9：一次性给范围内每篇参与编号的文档写 custom-doc-num-meta（一个 JSON 属性）。
     * 章节号来自 buildPlan 的祖先链 myChain，不查同级 / 其它分支；
     * 一次 batchSetBlockAttrs 批量提交，避免逐篇 210 次请求。dryRun 只算不写。
     */
    async syncScopeMeta(opt) {
        const o = opt || {};
        const cfg = this._config || DEFAULT_CONFIG;
        const ts = Array.isArray(cfg.targets) ? cfg.targets : [];
        const ex = Array.isArray(cfg.excluded) ? cfg.excluded : [];
        const exSelf = ex.filter((e) => e && e.id && e.mode !== "subtree").map((e) => e.id);
        const exTree = ex.filter((e) => e && e.id && e.mode === "subtree").map((e) => e.id);
        const dropSelf = new Set(exSelf);
        const dropTree = new Set(exTree);
        const items = [];
        const seen = new Set();
        for (const t of ts) {
            if (!t || !t.id) continue;
            const snap = await this.collect(t, {pruneIds: ownedDocIds(cfg, t)});
            const spec = specForTarget(cfg, t);
            DN.buildPlan(snap.tree, {
                skipPlaceholder: cfg.skipUntitled,
                skipIds: exSelf,
                skipSubtreeIds: exTree,
                formats: spec.formats,
                counters: spec.counters,
                maxLevel: spec.maxLevel,
                stripFormats: stripListFor(cfg, t),
                writeAttrs: true,
                emitMeta: true,
            });
            const walk = (node, virtual) => {
                const id = String(node.id || "");
                if (!virtual && dropTree.has(id)) return;
                if (!virtual && !dropSelf.has(id) && node.chain != null
                    && ID_RE.test(id) && !seen.has(id)) {
                    seen.add(id);
                    const rootID = (t.type === "notebook") ? DN.topDocIdOf(node.path) : t.id;
                    const attrs = {};
                    attrs[DN.META_ATTR] = DN.docNumMeta(rootID, node.chain, t.id);
                    items.push({id: id, attrs: attrs});
                }
                (node.children || []).forEach((c) => walk(c, false));
            };
            if ((t.type || "doc") === "notebook") walk(snap.tree, true);
            else walk(snap.tree, false);
        }
        const preview = {ok: true, count: items.length, dryRun: !!o.dryRun,
            sample: items.slice(0, 3)};
        if (o.dryRun) return preview;
        let written = 0;
        for (let i = 0; i < items.length; i += 100) {
            const chunk = items.slice(i, i + 100);
            await api("/api/attr/batchSetBlockAttrs", {blockAttrs: chunk});
            written += chunk.length;
        }
        return Object.assign(preview, {written: written});
    }

    /** 右键「编号：文档 + 内容」——先按树给文档标题编号，再给该子树每篇编内容标题。 */
    async numberBoth(target, opt) {
        const o = opt || {};
        const r = await this.runNumbering(target, {silent: true, source: "menu"});
        let body = null;
        try {
            let ids = await this.idsForTarget({type: target.type || "doc", id: target.id, box: target.box});
            const ex = (this._config && this._config.excluded) || [];
            const drop = new Set(ex.filter((e) => e.mode !== "subtree").map((e) => e.id));
            ids = ids.filter((id) => !drop.has(id));
            if (ids.length) body = await this.numberBodyRange(ids, {source: "menu", silent: true});
        } catch (e) { body = {ok: false, error: e.message}; }
        if (!o.silent) {
            const bt = body ? (body.ok ? "；内容 " + (body.docsHit || 0) + " 篇 / " + (body.changed || 0) + " 处"
                                       : "；内容失败：" + (body.error || ""))
                            : "；内容标题未启用";
            if (r.failed && r.failed.length) {
                msg("编号中断：" + (r.failed[0] || {}).error, 9000, "error");
            } else {
                msg("文档标题改 " + (r.changed || 0) + " 篇" + bt, 8000, "info");
            }
        }
        return {tree: r, body: body};
    }

    /**
     * 只算不写：采集一篇文档的标题、跑 buildBodyPlan，返回 {ok, docTitle, prefix, plan}。
     * 快捷键 / 自动 / 批量三个入口共用同一份判定与安全闸。
     */
    /** 把编号写进文档属性 custom-doc-num（v0.8.0）。
     *  这是「模板怎么变都无所谓」的关键：号存在文档上，正文编号只读属性，不再猜标题长相。
     *  num 为空 → 清掉属性（文档被排除 / 不再编号时）。 */
    async writeDocNumAttr(id, num, pad, meta) {
        if (!id || !ID_RE.test(String(id))) return false;
        const attrs = {
            "custom-doc-num": (num == null || num === "") ? "" : String(num),
            "custom-doc-pad": (pad ? String(pad) : ""),
        };
        /* v0.8.9：meta 是 custom-doc-num-meta 的 JSON 字符串，和上面两个属性一次写掉。 */
        if (meta != null) attrs[DN.META_ATTR] = String(meta);
        try {
            await api("/api/attr/setBlockAttrs", {id: id, attrs: attrs});
            return true;
        } catch (e) { return false; }
    }

    /** 读文档属性里的编号。实时接口优先，失败退回 SQL（ial 字段）。 */
    async readDocNumAttr(id) {
        const empty = {num: "", pad: 0};
        if (!id || !ID_RE.test(String(id))) return empty;
        try {
            const d = await api("/api/attr/getBlockAttrs", {id: id});
            const attrs = (d && d.attrs) || d || {};
            const num = attrs["custom-doc-num"];
            if (num != null && String(num).trim()) {
                return {num: String(num).trim(), pad: Number(attrs["custom-doc-pad"]) || 0};
            }
            return empty;
        } catch (e) { /* 落到 SQL */ }
        try {
            const rows = await sql("SELECT ial FROM blocks WHERE id='" + esc(id) + "' LIMIT 1");
            const ial = rows && rows[0] ? String(rows[0].ial || "") : "";
            const m = /custom-doc-num="([^"]*)"/.exec(ial);
            if (!m || !String(m[1]).trim()) return empty;
            const pm = /custom-doc-pad="([^"]*)"/.exec(ial);
            return {num: String(m[1]).trim(), pad: pm ? (Number(pm[1]) || 0) : 0};
        } catch (e) { return empty; }
    }

    async bodyPlanFor(docId, opt) {
        const o = opt || {};
        const cfg = this._config || DEFAULT_CONFIG;
        if (!docId || !ID_RE.test(String(docId))) return {ok: false, reason: "bad-id"};
        let docTitle = String(o.docTitle || "");
        if (!docTitle) {
            const t = await sql("SELECT content FROM blocks WHERE id='" + esc(docId) + "' LIMIT 1");
            if (!t.length) return {ok: false, reason: "no-doc", docId: docId};  // 文档刚删 / 索引未就绪：宁跳过
            docTitle = String(t[0].content || "");
        }
        const ordered = await this.collectBodyBlocks(docId);
        if (!ordered.length) return {ok: false, reason: "empty", docId: docId, docTitle: docTitle};
        if (ordered.truncated) {
            return {ok: false, reason: "too-large", docId: docId, docTitle: docTitle,
                    blocks: ordered.length};
        }
        const mdMap = await this.bodyMarkdowns(ordered);
        /* 任何一个标题块读不到 → 整篇这轮不算不写。半套编号比不编号更糟：
         * 读不到的块不参与计数，后面的号会整体前移，下一轮读到又改回来 → 来回振荡。 */
        const unread = ordered.filter((b) => mdMap.get(b.id) === null);
        if (unread.length) {
            return {ok: false, reason: "read-failed", docId: docId, docTitle: docTitle,
                    unread: unread.length};
        }
        const blocks = ordered.map((b) => ({id: b.id, level: b.level, markdown: mdMap.get(b.id) || ""}));
        /* 新插入的块 SQL 未就绪时 meta 缺失、level 读成 0：从实时 kramdown 的 # 数兜底推导，
         * 否则插入标题那一轮会被整篇跳过（v0.6.0 E2E 测试 4 抓到）。段落不会以未转义 # 开头，安全。 */
        blocks.forEach((b) => {
            if (!b.level) {
                const m = /^\s{0,3}(#{1,6})\s/.exec(String(b.markdown || ""));
                if (m) b.level = m[1].length;
            }
        });
        const bodyFmt = cfg.bodyFormats ? BN.normalizeBodyFormats(cfg.bodyFormats)
                                        : BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS);
        const stripFmts = bodyStripList(cfg, bodyFmt);
        /* v0.8.0：优先用文档属性里的号；没有属性（老文档 / 还没跑过树编号）才回退标题识别 */
        const numAttr = await this.readDocNumAttr(docId);
        const r = BN.buildBodyPlan({docTitle: docTitle, blocks: blocks,
                                    docNum: numAttr.num, docNumPad: numAttr.pad,
                                    focus: null, formats: bodyFmt, stripFormats: stripFmts,
                                    normalizeDepth: true});
        if (r.reason === "no-prefix") return {ok: false, reason: "no-prefix", docId: docId, docTitle: docTitle};
        /* 安全闸（2026-11-07 真机事故教训）：剥完只剩井号 / 空内容的条目绝不写 */
        const safe = r.plan.filter((p) => String(p.to || "").replace(/^#+\s*/, "").trim());
        return {ok: true, docId: docId, docTitle: docTitle, prefix: r.prefix,
                prefixKind: r.prefixKind, depthShift: r.depthShift || 0, plan: safe};
    }

    /**
     * 整篇重算一个文档的正文标题编号（自动路径；不转层级、不看光标）。
     * 与快捷键路径共用 collectBodyBlocks / buildBodyPlan / 撤销快照，安全闸完全一致。
     */
    async numberBodyDoc(docId, opt) {
        const o = opt || {};
        const g = await this.bodyPlanFor(docId, o);
        if (!g.ok) return g;
        const docTitle = g.docTitle;
        if (!g.plan.length) return {ok: true, changed: 0, docId: docId, docTitle: docTitle, plan: []};
        await this.saveData(BODY_UNDO_FILE, JSON.stringify({
            time: new Date().toISOString(), docId: docId, docTitle: docTitle,
            source: o.source || "auto",
            changes: g.plan.map((p) => ({id: p.id, from: p.from, to: p.to})),
        }, null, 2));
        const failed = [];
        let changed = 0;
        for (const p of g.plan) {
            try {
                await api("/api/block/updateBlock", {id: p.id, dataType: "markdown", data: p.to});
                changed++;
            } catch (e) {
                failed.push({id: p.id, error: e.message});
                break;   // 不继续写后面的，避免半套编号
            }
        }
        if (!o.silent && failed.length) {
            msg("正文自动编号中断：已改 " + changed + " 处，可用「撤销上次正文编号」回退", 9000, "error");
        }
        return {ok: !failed.length, changed: changed, docId: docId, docTitle: docTitle,
                plan: g.plan, failed: failed};
    }

    /**
     * 批量给一批文档的正文编号（v0.6.1）：先全部算完，再写一份「整批」撤销快照，最后逐块写。
     * opt.dryRun = true 时只算不写，供预检与面板预览。
     */
    async numberBodyRange(docIds, opt) {
        const o = opt || {};
        const list = (docIds || []).filter((id) => ID_RE.test(String(id)));
        if (!list.length) return {ok: false, reason: "no-docs", docs: [], total: 0};
        const docs = [];
        const changes = [];
        for (const id of list) {
            let g;
            try { g = await this.bodyPlanFor(id, {}); }
            catch (e) { docs.push({docId: id, ok: false, reason: "error:" + e.message}); continue; }
            if (!g.ok) { docs.push({docId: id, ok: false, reason: g.reason, docTitle: g.docTitle || ""}); continue; }
            docs.push({docId: id, ok: true, docTitle: g.docTitle, prefix: g.prefix,
                       depthShift: g.depthShift, changed: g.plan.length});
            g.plan.forEach((p) => changes.push({docId: id, id: p.id, from: p.from, to: p.to}));
        }
        const hit = docs.filter((d) => d.ok && d.changed > 0).length;
        if (o.dryRun) return {ok: true, dryRun: true, docs: docs, total: changes.length, docsHit: hit};
        if (!changes.length) return {ok: true, docs: docs, total: 0, changed: 0, docsHit: 0};
        /* 整批共用一份快照：一次「撤销上次正文编号」把这一批全部还原（undoBodyNumbering 逐条回写 from） */
        await this.saveData(BODY_UNDO_FILE, JSON.stringify({
            time: new Date().toISOString(), source: o.source || "range", batch: true,
            docIds: list,
            changes: changes,
        }, null, 2));
        const failed = [];
        let changed = 0;
        for (const c of changes) {
            try {
                await api("/api/block/updateBlock", {id: c.id, dataType: "markdown", data: c.to});
                changed++;
            } catch (e) {
                failed.push({docId: c.docId, id: c.id, error: e.message});
                break;   // 中断即停，避免半套编号；已写的条目都记在快照里
            }
        }
        if (!o.silent) {
            if (failed.length) msg("正文批量编号中断：已改 " + changed + " 处，可用「撤销上次正文编号」整批回退", 9000, "error");
            else msg("已给 " + hit + " 篇、共 " + changed + " 处正文标题编号", 7000, "info");
        }
        return {ok: !failed.length, docs: docs, total: changes.length, changed: changed,
                docsHit: hit, failed: failed};
    }

    onBodyHotkey(ev) {
        if (!ev || ev.repeat || ev.isComposing) return;
        if (this._config && this._config.bodyEnabled === false) return;   // 面板里关了快捷键
        if (!ev.ctrlKey || !ev.altKey || ev.shiftKey || ev.metaKey) return;
        const t = ev.target;
        const tag = t && t.tagName ? String(t.tagName).toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || tag === "select") return;
        if (t && t.closest && t.closest(".b3-dialog")) return;
        const m = /^(?:Digit|Numpad)([1-5])$/.exec(String(ev.code || ""));
        if (!m || Number(m[1]) > BN.LEVEL_MAX) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.numberBodyAtCursor(Number(m[1])).catch((e) =>
            msg("正文编号失败：" + e.message, 8000, "error"));
    }

    /* ---------------- 自动触发 ---------------- */

    onWsMain(event) {
        const d = event && event.detail;
        if (!d) return;
        const cmd = String(d.cmd || "");

        // 拖动排序：事件自带 childIDs（新顺序），先记下来，collect 时优先采用
        if (cmd === "filetreeSortChanged") {
            const o = DN.orderFromSortEvent(d.data);
            if (o) this._pendingOrders[o.parentPath] = {ids: o.ids, ts: Date.now()};
        }
        // 正文自动编号：只认 savedoc —— 它自带 rootID（文档 ID）；transactions 的
        // update/delete op.rootID 实测为空串，定位不了文档，弃用（2026-11-07 探针报告）
        if (cmd === "savedoc") {
            this.onSaveDoc(d);
            return;
        }
        if (!DN.isStructuralCmd(cmd)) return;   // 打字产生的 transactions 等一律不理

        const cfg = this._config || DEFAULT_CONFIG;
        if (!cfg.enabled || !cfg.targets.length) return;
        /* v0.8.7：只检查事件命中的范围。改前实测一次结构事件会全量扫 5 个范围
         * （163 个请求 / 1.1s）；现在按 box 裁剪。payload 判不准时 keysForEvent 返回
         * null → this._autoKeys 置 null → 退回全量，不会漏编。 */
        const keys = keysForEvent(cfg, cmd, d.data);
        if (keys === null) this._autoKeys = null;
        else if (this._autoKeys !== null) {
            if (!this._autoKeys) this._autoKeys = new Set();
            keys.forEach((k) => this._autoKeys.add(k));
        }
        clearTimeout(this._autoTimer);
        this._autoTimer = setTimeout(() => {
            const only = this._autoKeys;
            this._autoKeys = null;
            this.autoCheck(only ? {onlyKeys: Array.from(only)} : {})
                .catch((e) => console.warn("[doc-num] 自动检查失败", e));
        }, Number(cfg.debounceMs) || 1500);
    }

    /**
     * 结构指纹比对：只有树真的变了才重排。
     * 插件自己改名引发的 rename 事件最多让这里空转一轮（plan 为空，不写库），之后指纹收敛，不会自激。
     */
    async autoCheck(opt) {
        const o = opt || {};
        /* v0.8.7：结构事件会按 box 算出受影响的范围，这里只检查它们。
         * 不传 / 判不准（removeDoc 无 box）时仍是全量，行为与旧版一致。 */
        const onlyKeys = Array.isArray(o.onlyKeys) ? new Set(o.onlyKeys) : null;
        const cfg = await this.getConfig();
        if (!cfg.enabled || !cfg.targets.length) return {ok: true, skipped: true, details: []};
        if (this._autoBusy || this._running) {
            this._autoPending = true;
            return {ok: true, busy: true, details: []};
        }
        if (!this._osc) this._osc = {};   // key -> {sig, hits}，用于检测两套口径来回改写
        this._autoBusy = true;
        const details = [];
        try {
            for (const t of cfg.targets.slice()) {
                const key = targetKey(t);
                if (onlyKeys && !onlyKeys.has(key)) continue;
                const prune = ownedDocIds(cfg, t);
                try {
                    const snap = await this.collect(t, {pruneIds: prune});
                    const fp = DN.fingerprint(snap.tree);
                    if (this._fp[key] === fp && !o.force) {
                        delete this._osc[key];
                        details.push({key, changed: 0, reason: "unchanged"});
                        continue;
                    }
                    const r = await this.runNumbering(t,
                        {silent: !cfg.notify, source: "auto", snapshot: snap});
                    details.push({key, changed: r.changed, verified: r.verified, reason: "renumbered"});
                    // 用编号后的状态收敛指纹，挡住自己改名发出的 rename 事件
                    const after = await this.collect(t, {pruneIds: prune});
                    this._fp[key] = DN.fingerprint(after.tree);

                    /* 熔断：同一组 from→to 连续出现 3 轮，说明另有口径把标题改回去了。
                     * 正常情况下自己改名后下一轮 plan 为空，不会连续重复。 */
                    const sig = (r.plan || []).map((p) => p.id + ":" + p.from + ">" + p.to).join("|");
                    const prev = this._osc[key];
                    const rec = {sig, hits: prev && prev.sig === sig ? prev.hits + 1 : 1};
                    this._osc[key] = rec;
                    if (sig && rec.hits >= 3) {
                        cfg.enabled = false;
                        await this.saveConfig();
                        this.refreshTopBar();
                        msg("检测到编号在两套格式间反复切换（编号范围可能重叠），已暂停自动编号。"
                            + "请到顶栏面板检查范围设置后再启用", 12000, "error");
                        details.push({key, reason: "oscillation-paused"});
                        break;
                    }
                } catch (e) {
                    details.push({key, error: e.message});
                }
            }
        } finally {
            this._autoLog.push({time: new Date().toISOString(), details});
            if (this._autoLog.length > 60) this._autoLog.shift();
            this._autoBusy = false;
            if (this._autoPending) {
                this._autoPending = false;
                this._autoPendingHits = (this._autoPendingHits || 0) + 1;
                if (this._autoPendingHits <= AUTO_PENDING_MAX) {
                    const again = onlyKeys ? {onlyKeys: Array.from(onlyKeys)} : {};
                    setTimeout(() => this.autoCheck(again).catch(() => {}), 500);
                } else {
                    this._autoPendingHits = 0;
                    console.warn("[doc-num] 自动检查已连续补跑 " + AUTO_PENDING_MAX
                                 + " 轮，停止空转，等待下一次结构事件");
                }
            } else {
                this._autoPendingHits = 0;
            }
        }
        return {ok: true, details};
    }

    getAutoLog() {
        return this._autoLog.slice();
    }

    /** 自检用：模拟一次拖动事件（真机验证不必强抢 UI 焦点去拖 DOM） */
    emitSort(parentPath, ids) {
        this.onWsMain({detail: {cmd: "filetreeSortChanged", data: {parentPath, childIDs: ids}}});
        return true;
    }
};
