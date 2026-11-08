/* 正文标题编号核心 v0.5.0：纯函数，不碰 DOM、不碰网络。Node 单测与思源插件共用同一份代码。
 * 口径（2026-11-07 15:20 用户定，见 需求确认.md Q18）：
 *   前缀 = 文档标题里的节编号（「第1.1节 …」→ 1.1）；没有节编号但有章编号时取章编号（「第3章 …」→ 3）
 *   内置默认模板（v0.5.1 起可在设置面板逐级自定义）：
 *     1 级 {prefix}.{n} → 1.1.1 / 3.1      2 级 {h1}.{n} → 1.1.1.1 / 3.1.1
 *     3 级 （{n}）→ （1）   4 级 {n}）→ 1）   5 级 {cn} → ①
 *   占位符：{prefix} 节/章编号 · {n} 本层序号 · {h1} 所属一级的编号 · {cn} 圈码①…⑳（>20 退化为（21））
 *   括号 / 圈码序号按所属上级重排；H6 及更深不编号。
 *   快捷键 Ctrl+Alt+N：把光标所在段落设为第 N 级标题，再级联重算整篇标题编号，只输出变化块。
 *
 * 实测硬坑（probe/正文编号探针报告.md）：updateBlock 后 SQL 的 content/markdown 有索引滞后，
 * 实时判据必须用 /api/block/getBlockKramdown；本模块只做纯计算，读写全部交给插件层。
 */
;(function (g) {
    "use strict";

    var LEVEL_MAX = 5;
    var CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

    function circled(n) {
        return (n >= 1 && n <= CIRCLED.length) ? CIRCLED.charAt(n - 1) : "（" + n + "）";
    }

    /** 内置默认模板（2026-11-07 15:20 用户口径）。空 / 缺模板一律回退到这里。 */
    var BUILTIN_BODY_FORMATS = {
        1: "{prefix}.{n}",
        2: "{h1}.{n}",
        3: "（{n}）",
        4: "{n}）",
        5: "{cn}",
    };

    /** 把用户配置补齐成 {1..5} 全有值的模板表；空白模板回退内置默认（保留用户模板的首尾空格）。
     *  只收 {1..5} 键对象：数组按数字下标取值会整体错位一级（真机踩过），一律不认。 */
    function normalizeBodyFormats(obj) {
        var src = (obj && !Array.isArray(obj)) ? obj : null;
        var out = {};
        for (var lv = 1; lv <= LEVEL_MAX; lv++) {
            var s = src && src[lv] != null ? String(src[lv]) : "";
            out[lv] = s.trim() ? s : String(BUILTIN_BODY_FORMATS[lv]);
        }
        return out;
    }

    /** 数字格式化：与文档侧共用一份实现（打包时 numbering.js 先加载并挂到 globalThis）。
     *  单测若只 require 本文件，退化原样输出——body_numbering_unit.js 已在顶部 require numbering.js。 */
    function fmtNum(v, fmt) {
        var g = (typeof globalThis !== "undefined") ? globalThis : {};
        if (g.DocNumbering && typeof g.DocNumbering.formatNum === "function") {
            return g.DocNumbering.formatNum(v, fmt);
        }
        return String(v == null ? "" : v);
    }
    function numRe(fmt, multi) {
        var g = (typeof globalThis !== "undefined") ? globalThis : {};
        if (g.DocNumbering && typeof g.DocNumbering.numPattern === "function") {
            return multi ? g.DocNumbering.numPatternAll(fmt) : g.DocNumbering.numPattern(fmt);
        }
        return multi ? "\\d+(?:\\.\\d+)*" : "\\d+";
    }

    /** 渲染一级的编号模板。ctx = {prefix, n, h1, cn, title, fn:[], hn:[]}；空白模板回退该级内置默认。
     * 模板原样渲染（不掐首尾空格）。单遍替换：标题文字里就算含 "{n}" 字样也不会被二次展开。
     * {title} = 剥掉旧号后的原标题（2026-11-07 15:45 用户期望口径，与文档树模板一致）。
     * v0.7.0 新词表（与文档标题模板共用同一套）：
     *   {fn1}~{fn5} = 本文档在文档树上第 K 级的序号（单个整数，1.1.1.4 → fn4=4）
     *   {fn}        = 本文档完整号（fn1.fn2…，如 2.1）——等价旧 {prefix}
     *   {hn1}~{hn5} = 本文档内容标题第 K 级的序号（按文档内深度归一，没有 H1 时 H2 就是 hn1）
     *   {hn}        = 内容各级号连起来（1.1…）
     * 旧写法全部保留为别名：{prefix}={fn}、{n}={hn 本级}、{h1}={hn1}、{cn}=①。 */
    function renderBodyTemplate(tpl, level, ctx) {
        var c = ctx || {};
        var s = String(tpl == null ? "" : tpl);
        if (!s.trim()) s = String(BUILTIN_BODY_FORMATS[level] || "");
        var fnArr = c.fn || [], hnArr = c.hn || [];
        /* v0.8.5：{fnK} / {hnK} = 第 K 级的**单个序号**（1.1.1.4 → fn1=1、fn2=1、fn3=1、fn4=4），
         * 与文档标题模板同一套语义。旧「前 K 级连号」已废弃，缺级返回空串。 */
        function pick(arr, k) {
            var v = (arr || [])[k];
            if (v == null || v === "" || Number(v) === 0) return "";
            return String(v);
        }
        function joined(arr) {
            var out = [];
            for (var i = 1; i <= LEVEL_MAX; i++) {
                var v = (arr || [])[i];
                if (v == null || v === "" || Number(v) === 0) break;
                out.push(String(v));
            }
            return out.join(".");
        }
        return s.replace(/\{(title|prefix|h1|cn|n|fn[1-5]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g,
            function (m, k, fmt) {
            var f = fmt || "";
            if (k === "title") return String(c.title == null ? "" : c.title);
            if (k === "prefix") return fmtNum(c.prefix, f);
            if (k === "h1") return fmtNum(c.h1, f);
            if (k === "cn") return String(c.cn == null ? "" : c.cn);
            if (k === "n") return fmtNum(c.n, f);
            if (k === "fn") return fmtNum(joined(fnArr) || c.prefix, f);
            if (k === "hn") return fmtNum(joined(hnArr), f);
            if (k.charAt(0) === "f") return fmtNum(pick(fnArr, Number(k.charAt(2))), f);
            if (k.charAt(0) === "h") return fmtNum(pick(hnArr, Number(k.charAt(2))), f);
            return "";
        });
    }

    /** 文档标题 → 编号前缀。节编号优先、章编号兜底；都没有返回 null（插件应跳过并提示）。 */
    function extractPrefix(docTitle) {
        var s = String(docTitle == null ? "" : docTitle);
        var m = /第\s*(\d+(?:\.\d+)*)\s*节/.exec(s);
        if (m) return {value: m[1], kind: "节"};
        m = /第\s*(\d+(?:\.\d+)*)\s*章/.exec(s);
        if (m) return {value: m[1], kind: "章"};
        /* v0.7.7：树编号模板的其它产出形态也要认，否则「文档能被树编号写出号、正文却不认」——
         * 与 v0.6.3 的教训同一类（2026-11-07 用户报《03【 主持或参与的主要科研项目】》正文没编号）：
         *   模板 1「{n}【{title}】」→ `03【 主持…】`；模板 2「【{n}】{title}」→ `【3】标题`；
         *   模板 3「第{n}篇{title}」/ 旧默认「第{n}部 {title}」→ `第3篇…` / `第3部 …`。
         * 都只认开头、只认 1~3 位数字，避免把正文里的数字当号。 */
        m = /^\s*(\d{1,3})\s*【/.exec(s);
        if (m) return {value: m[1], kind: "章"};
        m = /^\s*【\s*(\d{1,3})\s*】/.exec(s);
        if (m) return {value: m[1], kind: "章"};
        m = /第\s*(\d{1,3})\s*[篇部]/.exec(s);
        if (m) return {value: m[1], kind: "章"};
        /* v0.6.3（2026-11-07 用户反馈「2.1 BBBBB 没编号」）：树编号模板第 2 级就是
         * `{parentN}.{n} {title}`，产出的文档标题正是「2.1 标题」这种无「第/节」的形态，
         * 正文编号若不认它就自相矛盾。只在开头位置匹配、且必须带小数点（x.y），
         * 避免把「2024 年度总结」「3 个方法」这类纯整数标题误当成章号。 */
        m = /^\s*(\d{1,3}(?:\.\d{1,3})+)(?:\s*[、.．:：]\s*|\s+)/.exec(s);
        if (m) return {value: m[1], kind: "节"};
        return null;
    }

    /* 模板 → 剥旧号正则：逐字符扫描，占位符换子正则、其余字面量逐个转义。
     * {prefix} / {h1} → \d+(\.\d+)*，配 {n} 后数字编号天然至少两段，不会吃掉手写「第1章」；
     * 中文数字「第一章」不受影响；手写「1.1 结果」会被剥（与内置形态同形，已知代价）。
     * {title} 之后是标题正文，不进剥号正则（剥正则只该匹配号，不能吞标题）。 */
    function bodyStripRegex(tpl) {
        var s0 = String(tpl == null ? "" : tpl).trim();
        if (!s0) return null;
        var TOKEN = /^\{(prefix|title|h1|cn|n|fn[1-5]|hn[1-5]|fn|hn)(?::([^}]*))?\}/;
        var out = "", i = 0;
        while (i < s0.length) {
            var m = TOKEN.exec(s0.slice(i));
            if (m) {
                var k = m[1], fmt = m[2] || "";
                if (k === "title") {
                    out = out.replace(/(\\ )+$/, "");   // 号与标题之间的分隔空格交给 \s* 处理
                    break;
                }
                if (k === "cn" && !fmt) out += "[①-⑳]";
                else if (k === "n" || k === "parentN") out += numRe(fmt, false);
                else out += numRe(fmt, true);            // prefix/h1/fn/hn/fnK/hnK 可能是复合号
                i += m[0].length;
                continue;
            }
            var ch = s0.charAt(i);
            out += /[A-Za-z0-9\u4e00-\u9fff\u2460-\u2473\u3000-\u303f\uff00-\uffef]/.test(ch) ? ch : "\\" + ch;
            i += 1;
        }
        if (!out) return null;
        try { return new RegExp("^" + out + "\\s*"); } catch (e) { return null; }
    }

    /* 旧硬编码剥正则（模板化前的内置形态，与内置模板派生结果等价，留作兜底）。 */
    /* 行首「.1 .1 .1 …」累积残渣：v0.8.1 之前的 {h1} 缺陷会造出这种标题。
     * 要求至少 2 段（`.1 .1`），所以 `.5 小时` 这种正常文字不会被误剥。 */
    var RE_DOT_RESIDUE = /^(?:\.+\d+\s+){2,}/;   // 允许多个点（`..1 ..1` 也见过）
    /* v0.8.4：点开头的碎渣。v0.8.1~0.8.3 反复换模板时留下 `..2 2 主要功能`、`..5 5 依赖`
     * 这类残渣 —— 里面带点，各代模板剥掉的长度不同 → 每轮算出不同结果，越改越乱。
     * ① `.N N` 重复数字对（同号出现两次）→ 直接整段删；
     * ② 剩余点开头的 `.N` / `..N` → 也删。行首以「.数字」开头的标题不可能是正文，
     *   所以 `.5 小时` 会被剥成「小时」—— 这个取舍是故意的，编号必须收敛。 */
    var RE_DUP_PAIR = /^[.\s]*\.\s*(\d{1,3})\s+\1\s*/;
    var RE_DOT_JUNK = /^[.\s]*\.{1,}\s*\d{1,3}\s*/;
    var RE_NUM = /^\d+(?:\.\d+){1,}\s*/;
    /* 半角/全角都认：模板多半产出全角，但用户手写的半角 `(1) 标题` 如果剥不掉，
     * 会一直糊在标题前面（2026-11-07 真机见到 `(1) 首先加载R包` 与 `（1）冗余分析` 混排）。 */
    var RE_PAREN = /^[（(]\d{1,3}[）)]\s*/;
    var RE_HALF = /^\d+）\s*/;
    var RE_CIRCLE = /^[①-⑳]\s*/;
    /* 非法占位符残渣（v0.8.4）：模板里写了**不存在的占位符**（如 `{fh3}`）时，渲染不替换、
     * 原样写进标题（真机：把内容 1 级写成 `{fh3}.{fn4}.{n}` → 标题成了
     * `1.1 {fh3}..1 {fh3}..1 土壤和表面水 N 动态`）。
     * 只清「白名单以外」的名字：合法占位符当正文出现（如标题就叫 `{n}试验`）时保持原样。 */
    var VALID_PH = /^(title|prefix|h1|cn|n|nn|parentN|parentNN|fn[1-5]|hn[1-5]|fn|hn)(:[^}]*)?$/;
    function stripTplJunk(body) {
        var t = String(body == null ? "" : body);
        var bad = false, guard = 0, changed = true;
        while (changed && guard++ < 6) {
            changed = false;
            var m = /^\s*\{([^{}\s]{1,24})\}\s*/.exec(t);
            if (m && !VALID_PH.test(m[1])) { t = t.slice(m[0].length); bad = true; changed = true; }
            /* 没见到非法占位符就别动后面的点/数字 —— 那是别的规则（RE_DUP_PAIR 等）的活，
             * 在这里先剥会把 `..2 2` 拆成 `2 2`，反而清不干净。 */
            if (!bad) break;
            var t2 = t.replace(/^[.\s]+/, "").replace(/^\d{1,3}\s+(?=[^\d])/, "");
            if (t2 !== t) { t = t2; changed = true; }
        }
        return t;
    }
    var STRIP_RES = [RE_DUP_PAIR, RE_DOT_JUNK, RE_DOT_RESIDUE, RE_NUM, RE_PAREN, RE_HALF, RE_CIRCLE];

    /** 由模板列表（当前 → 上次 → 内置 → 旧硬编码）汇总剥旧号正则。 */
    function bodyStripRegexes(stripFormats) {
        var res = [];
        (stripFormats || []).forEach(function (f) {
            if (!f) return;
            var fmts = normalizeBodyFormats(f);
            for (var lv = 1; lv <= LEVEL_MAX; lv++) {
                var r = bodyStripRegex(fmts[lv]);
                if (r) res.push(r);
            }
        });
        return res.concat(STRIP_RES);
    }

    /** 剥掉标题文字开头已有的编号（可叠加多层），保留 <sub> / ** 等内联 markdown。 */
    function stripNumber(body, strips) {
        var s = String(body == null ? "" : body);
        var list = strips && strips.length ? strips : STRIP_RES;
        var guard = 0, changed = true;
        while (changed && guard++ < 6) {
            changed = false;
            var tpl = stripTplJunk(s);
            if (tpl !== s) { s = tpl; changed = true; }
            for (var i = 0; i < list.length; i++) {
                if (list[i].test(s)) {
                    s = s.replace(list[i], "");
                    changed = true;
                }
            }
        }
        return s;
    }

    /* 用户手写的行首序号：1. / 1) / 1、 / 1． / （1） / (1)。
     * 为什么必须剥：这类标题直接套模板会变成「35.1 1. The data…」双层号
     * （2026-11-07 用户报《第35章 2025 经典句型》，19 条里 17 条自带手写号）。
     * 三条硬约束，防止误伤：
     *   ① 只认「单段数字」1~999，所以 1.1 / 35.9.3 这类复合号不在这里处理（交给 stripNumber 按模板剥）；
     *   ② 点号后面紧跟数字或点 → 不认（`1.1` 不会被剥成 `1`）；
     *   ③ `2024. 年度总结` 这种 4 位数字不认（\d{1,3} 匹配不到点号前）。
     * 最多剥 3 层，处理「1. 2. 标题」这种历史叠号。 */
    var HAND_NUM_RES = [
        /^\s*[（(]\s*\d{1,3}\s*[）)]\s*/,      // （1） / (1)
        /^\s*\d{1,3}\s*[、．]\s*/,              // 1、 / 1．
        /^\s*\d{1,3}[.)）](?!\d)(?!\.)[ \t]*/  // 1. / 1) / 1）—— 括号后不能紧跟数字或点
    ];

    function stripHandNumber(body) {
        var s = String(body == null ? "" : body);
        for (var round = 0; round < 3; round++) {
            var hit = false;
            for (var i = 0; i < HAND_NUM_RES.length; i++) {
                if (HAND_NUM_RES[i].test(s)) { s = s.replace(HAND_NUM_RES[i], ""); hit = true; }
            }
            if (!hit) break;
        }
        return s;
    }

    /** 拆出 # 前缀与正文；普通段落没有 # 前缀。 */
    function splitMarkdown(md) {
        var s = String(md == null ? "" : md);
        var m = /^(#{1,6})\s+([\s\S]*)$/.exec(s);
        return m ? {hashes: m[1], body: m[2]} : {hashes: "", body: s};
    }

    function hashesFor(level) {
        return new Array(Number(level) + 1).join("#");
    }

    /**
     * 生成正文标题编号计划。
     * opts = {
     *   docTitle: 文档标题文字,
     *   blocks: [{id, level, markdown}]   level 1..6 为标题块，0/null 为普通段落；按文档真实顺序
     *   focus:   {id, level} 可选，快捷键触发时把该块设为第 level 级标题
     *   formats: {1..5} 可选，各级编号模板；缺省用内置默认
     *   stripFormats: [格式表] 可选，剥旧号候选（当前 → 上次 → 内置），缺省只看当前
     * }
     * 返回 {prefix, prefixKind, reason, formats, plan:[{id, from, to, level, number}]}
     */
    function buildBodyPlan(opts) {
        var o = opts || {};
        /* v0.8.0：优先用文档属性里的号（树编号时写进 custom-doc-num）。
         * 这样模板怎么改都不影响正文编号 —— 号存在文档上，不再靠标题长相猜。
         * 属性缺失（老文档 / 还没跑过树编号）才回退标题识别。 */
        var pre;
        if (o.docNum != null && String(o.docNum).trim()) {
            var nv = String(o.docNum).trim();
            var padW = Number(o.docNumPad) || 0;
            if (padW) {
                /* 只补最后一段：模板的补零只作用于本级（第 1 级 {nn} 补两位，
                 * 第 2 级通常是 {parentN}.{n} 不补），整串逐段补会变成 01.03。 */
                var segs = nv.split(".");
                var last = segs.length - 1;
                segs[last] = fmtNum(segs[last], "0" + padW);
                nv = segs.join(".");
            }
            pre = {value: nv, kind: "attr"};
        } else {
            pre = extractPrefix(o.docTitle);
        }
        if (!pre) return {prefix: null, prefixKind: null, reason: "no-prefix", plan: []};

        var formats = normalizeBodyFormats(o.formats);
        var strips = bodyStripRegexes(
            o.stripFormats && o.stripFormats.length ? o.stripFormats : [formats]);

        var focus = o.focus || null;
        var blocks = (o.blocks || []).map(function (b) {
            var lv = Number(b.level) || 0;
            if (focus && String(b.id) === String(focus.id)) lv = Number(focus.level) || lv;
            return {id: b.id, level: lv, markdown: String(b.markdown == null ? "" : b.markdown)};
        });

        var cur = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0};

        /* v0.7.5：先算「有效级别」——以内容里的井号个数为准（SQL subtype 有索引滞后），
         * 非标题形态（残缺 "###"、段落）记 0。统一在这一层算，避免 shift 与循环各用一套口径
         * （审查发现过：shift 按元数据算、循环按内容算，两边不一致 → 模板错级）。 */
        var items = blocks.map(function (b) {
            var focused = !!(focus && String(b.id) === String(focus.id));
            var parts = splitMarkdown(b.markdown);
            var eff = focused ? (Number(b.level) || 0)
                             : (parts.hashes ? parts.hashes.length : 0);
            return {id: b.id, level: eff, markdown: b.markdown,
                    focused: focused, parts: parts};
        });

        /* 文档内深度归一（v0.6.1，2026-11-07 用户定）：节级文档的标题常从 H2 起、整篇没有 H1，
         * 按字面级别会把顶标题算成「二级」（第5.1节 → 5.1.1.1），与章级文档的 5.1.1 不一致。
         * shift = 最浅标题级别 − 1，模板与计数按「归一后的级别」取，井号个数仍按原级别不变。
         * 有 H1 的文档 shift=0，与旧行为逐字一致。 */
        var shift = 0;
        if (o.normalizeDepth === true) {
            var minLv = 99;
            for (var mi = 0; mi < items.length; mi++) {
                var mlv = items[mi].level;
                if (mlv >= 1 && mlv <= 6 && mlv < minLv) minLv = mlv;
            }
            if (minLv !== 99 && minLv > 1) shift = minLv - 1;
        }
        var lvOf = function (idx) {
            var l = idx - shift;
            return (l >= 1 && l <= LEVEL_MAX) ? l : 0;
        };

        /* {h1} = 所属一级的**纯号**（prefix.序号，如 01.1）。
         * v0.8.1 修：原来取模板 1 的渲染结果，用户把第 1 级模板写成 `[{n}] ` 时
         * {h1} 就成了 `[1] `，二级标题拼出 `[1] .1` —— 而剥号正则只认数字开头，
         * 永远剥不掉 → 每轮再加一段 `.1`，编号越来越长（2026-11-07 真机 14 段）。
         * 纯号既能被剥，也和 {prefix} 同源。 */
        /* 纯号的构成跟模板 1 走：
         *   模板 1 含 {prefix}（内置 `{prefix}.{n}`）→ `1.3.1`（完整号）
         *   模板 1 不含（用户写 `[{n}] `）→ `2`（只序号），第 2 级才是 `2.1`
         * 否则用户只要短标 `[2]` 时，二级会被撑成 `1.3.1.1.1`（真机扫描到 140 条）。 */
        var tpl1HasPrefix = /\{(?:prefix|fn|fn1|fn\d)\}/.test(String(formats[1] || ""));
        function pureH1(idx) {
            var parts = [];
            if (tpl1HasPrefix) parts.push(String(pre.value));
            parts.push(String(idx));
            return parts.filter(function (x) { return x !== "" && x != null; }).join(".");
        }
        var h1Num = pureH1(1);
        /* v0.7.0：文档树各级序号（{fn1}~{fn5}）。优先用插件算好的祖先链；
         * 没给就从前缀拆（前缀 2.1 → fn1=2, fn2=1），两者都拿不到时留空。 */
        var fnArr = [];
        if (Array.isArray(o.docNums) && o.docNums.length) {
            fnArr = o.docNums.slice();
        } else {
            String(pre.value).split(".").forEach(function (seg, i) {
                var v = parseInt(seg, 10);
                if (isFinite(v) && v > 0 && i < LEVEL_MAX) fnArr[i + 1] = v;
            });
        }
        var hnArr = [];                       // 内容各级序号（{hn1}~{hn5}），按归一后的级别
        var plan = [];

        for (var i = 0; i < items.length; i++) {
            var b = items[i], lv = b.level, parts = b.parts;
            /* 有效级别 0 = 不是标题（残缺 "###"、普通段落）→ 绝不改写 */
            if (lv < 1 || lv > LEVEL_MAX) continue;       // 普通段落 / H6+ 不编号
            if (!b.markdown.trim()) continue;   // 读不到内容的块绝不写（2026-11-07 真机教训：写空会清掉标题）
            var nl = lvOf(lv);
            if (!nl) continue;                  // 归一后掉出 1~5 级（极深标题）→ 不动
            for (var d = nl + 1; d <= LEVEL_MAX; d++) { cur[d] = 0; hnArr[d] = 0; }  // 换本级 → 更深层重排
            cur[nl]++;
            hnArr[nl] = cur[nl];
            /* 顺序很重要：先剥「用户手写序号」（1. / （1）），再剥「模板旧号」（35.1）——
             * 反过来也能工作，但先手写号能顺带清掉「1. 35.1 标题」这种历史叠号。 */
            var body = stripNumber(stripHandNumber(parts.body), strips);
            /* {title} 在模板里 → 标题位置由模板控制；{h1} 只引用纯编号，不能带上级标题文字 */
            var tplCore = String(formats[nl]).replace(/\s*\{title\}/g, "");
            var hasTitle = tplCore !== String(formats[nl]);
            var ctxNum = {prefix: pre.value, n: String(cur[nl]), h1: h1Num,
                          cn: circled(cur[nl]), title: body,
                          fn: fnArr, hn: hnArr};
            var numCore = renderBodyTemplate(tplCore, nl, ctxNum);
            var num = hasTitle ? renderBodyTemplate(formats[nl], nl, ctxNum) : numCore;
            var to;
            if (hasTitle) {
                to = hashesFor(lv) + " " + num;
            } else {
                // 编号以数字收尾 → 自动补一个空格（1.1.1）；括号 / 圈码 / 自定义形态收尾 → 不补，
                // 想带空格直接在模板末尾写空格（"{prefix}({n}) " → 1.1(1) 标题），幂等由剥号正则 \s* 保证。
                /* body 为空时绝不补尾随空格：思源存盘会把行尾空格吃掉，读回来永远「差一个空格」，
                 * 于是每轮都算出一处改动 → 自动重算无限循环（2026-11-07 真机事故：空标题「#### 35.9.3」）。 */
                to = hashesFor(lv) + " " + numCore
                    + (body && /\d$/.test(numCore.trimEnd()) ? " " : "") + body;
            }
            if (nl === 1) h1Num = pureH1(cur[1]);
            if (to.trimEnd() !== String(b.markdown).trimEnd()) {
                plan.push({id: b.id, from: b.markdown, to: to, level: lv, levelNorm: nl,
                           number: numCore});
            }
        }
        return {prefix: pre.value, prefixKind: pre.kind, reason: "ok", plan: plan,
                formats: formats, depthShift: shift};
    }

    var api = {
        LEVEL_MAX: LEVEL_MAX,
        CIRCLED: CIRCLED,
        BUILTIN_BODY_FORMATS: BUILTIN_BODY_FORMATS,
        circled: circled,
        normalizeBodyFormats: normalizeBodyFormats,
        renderBodyTemplate: renderBodyTemplate,
        extractPrefix: extractPrefix,
        bodyStripRegex: bodyStripRegex,
        stripHandNumber: stripHandNumber,
        stripTplJunk: stripTplJunk,
        bodyStripRegexes: bodyStripRegexes,
        stripNumber: stripNumber,
        splitMarkdown: splitMarkdown,
        hashesFor: hashesFor,
        buildBodyPlan: buildBodyPlan,
    };

    if (typeof globalThis !== "undefined") globalThis.BodyNumbering = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
