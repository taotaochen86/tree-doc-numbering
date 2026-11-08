/* 编号核心：纯函数，不碰 DOM、不碰网络。Node 单测与思源插件共用同一份代码。
 * 规则见 需求确认.md：
 *   Q1 第01部 原标题（前缀 + 半角空格 + 原标题）
 *   Q2（2026-11-07 11:33 用户改口径）部、章全书连续计数，跨父级不重置；
 *      节仍在每章下各自从 01 重排
 *   Q3 第四层及更深原样不动
 *   Q5 严格匹配 ^第\d{2,}[部章节]\s+ 才剥；手写「第1章」「1.1」原样保留
 *   Q7（2026-11-07 11:45 追加）各级编号顺序一律取文档树的自定义排序
 *   Q8（2026-11-07 11:45 追加）新增/删除/拖动/改名 → 自动重排；刚新建的占位标题暂不编号
 *   Q9（2026-11-07 13:05 追加）三级编号格式各可自定义，模板规则见 格式模板约定.md
 *   Q10（2026-11-07 14:26 追加）用户指定新的用户可见内置编号体系（五级）：
 *       1【title】global / 【1】title local / 第1部 local / 第1章「按上上级重排」
 *       / 第1.1节 local（前一个是父级章号）。见 BUILTIN_V4_* 与 格式模板约定.md。
 */
;(function (g) {
    "use strict";

    var LABELS = {1: "部", 2: "章", 3: "节"};
    var PREFIX_RE = /^第\d{2,}[部章节][ \t]+/;
    var CONFLICTED_RE = /\(Conflicted/i;
    var TITLE_TOKEN = "{title}";

    /* 内置默认模板：前三级输出与 v0.2.0 的硬编码逐字一致，升级不会改动用户已有标题。
     * 4/5 级是 2026-11-07 追加「最多 5 级」时给的可改默认值（名称由模板决定，改模板即可）。
     * 每个自动编号范围可以另存一份 formats；没存的继承全局 defaultFormats。 */
    var MAX_LEVEL = 5;
    var DEFAULT_MAX_LEVEL = 3;
    var DEFAULT_FORMATS = {
        1: "第{nn}部 {title}",
        2: "第{nn}章 {title}",
        3: "第{nn}节 {title}",
        4: "第{nn}条 {title}",
        5: "第{nn}款 {title}",
    };
    /* global = 整棵树同一层级一个流水号（部、章原口径）；
     * local  = 每进一个父文档从 01 重排（节原口径）。每级都可在面板里改。 */
    var DEFAULT_COUNTERS = {
        1: "global", 2: "global", 3: "local", 4: "local", 5: "local",
    };

    /* v0.4.0 用户指定的「用户可见内置默认」，由插件层 DEFAULT_CONFIG 采用。
     * 核心层刻意保留 v0.3 的 DEFAULT_FORMATS 作为纯函数回退：
     *   ① 60 项离线单测与四套真机回归验的是 v0.3 口径，不要推翻重写；
     *   ② 换格式时它恒定在剥离清单里，能把已经编号的旧标题（第01部…）剥干净。
     * 换句话说：DEFAULT_FORMATS = 核心回退 / 旧号兜底；BUILTIN_V4_FORMATS = 面板内置默认。 */
    var BUILTIN_V4_FORMATS = {
        1: "{n}【{title}】",
        2: "【{n}】{title}",
        3: "第{n}篇{title}",
        4: "第{n}章 {title}",
        5: "第{parentN}.{n}节 {title}",
    };
    /* v0.7.1 之前第 3 级的内置默认是「第{n}部 {title}」。改成「篇」以后，历史上已经编号成
     * 「第3部 …」的标题仍要能被剥掉，否则换默认就留下一层旧前缀 —— 所以它恒定进剥离清单，
     * 但不进面板、不参与「用户是否自定义过」的判断。 */
    var LEGACY_V4_FORMATS = {3: "第{n}部 {title}"};

    /* 历史上出现过的全部默认模板，**恒定**参与剥号（v0.8.2）。
     * 为什么必须恒定：老逻辑只拼「当前 + 上次 + 全局默认」，用户换过默认以后，
     * 更早那套形态就再也没人剥得掉 —— 而重排时算出的结果又与现状相同，
     * 于是**永远修不正**（2026-11-07 真机：第 3 级默认从「第{n}篇{title}」改成
     * 「{parentN}.{n} {title}」后，151 篇标题里压着的「第N篇」纹丝不动）。
     * 这些规则只认「像编号」的头部，正文里的普通数字不受影响。 */
    var HISTORY_FORMATS = [DEFAULT_FORMATS, BUILTIN_V4_FORMATS, LEGACY_V4_FORMATS];
    /* global     全书连续（换父不回 1）
     * local      按上一级重排（每换一个父文档从 1 重数）
     * grandlocal 按上上级重排（换父继续数，换祖父才回 1）—— 第4级「章」用，
     *            等价于旧口径「不同部里的章号应该连着，不能都从第01章开始」。 */
    var COUNTER_MODES = ["global", "local", "grandlocal"];
    var BUILTIN_V4_COUNTERS = {
        1: "global", 2: "local", 3: "local", 4: "grandlocal", 5: "local",
    };
    var BUILTIN_V4_MAX_LEVEL = 5;

    function clampLevel(n) {
        var v = Number(n);
        if (!isFinite(v) || v < 1) return DEFAULT_MAX_LEVEL;
        return Math.max(1, Math.min(MAX_LEVEL, Math.round(v)));
    }

    function normalizeFormats(obj, fallback) {
        var def = fallback || DEFAULT_FORMATS;
        var out = {};
        for (var lv = 1; lv <= MAX_LEVEL; lv++) {
            var s = obj && obj[lv] != null ? String(obj[lv]) : "";
            out[lv] = s.trim() ? s : (def[lv] || DEFAULT_FORMATS[lv]);
        }
        return out;
    }

    function normalizeCounters(obj) {
        var out = {};
        for (var lv = 1; lv <= MAX_LEVEL; lv++) {
            var v = obj && obj[lv];
            out[lv] = COUNTER_MODES.indexOf(v) >= 0 ? v : DEFAULT_COUNTERS[lv];
        }
        return out;
    }

    /** 模板为空 → 回退内置；忘了写 {title} → 补在末尾，绝不丢掉原标题。 */
    function normalizeTemplate(tpl, level, fallback) {
        var def = fallback || DEFAULT_FORMATS;
        var s = String(tpl == null ? "" : tpl);
        if (!s.trim()) s = def[level] || def[1] || DEFAULT_FORMATS[1];
        if (s.indexOf(TITLE_TOKEN) < 0) s = s + " " + TITLE_TOKEN;
        return s;
    }

    function escapeRe(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }


    /* ---------------- 数字输出格式（v0.7.1，用户要 A 方案：复合号逐段转换） ----------------
     * 模板里写 {占位符:格式}，格式只影响「显示」，不影响计数与比较：
     *   :cn 一二三   :CN 壹贰叁   :a / :A 字母   :o 或 :① 圈码   :i / :I 罗马   :03 补零到 3 位
     * 复合号（2.1）逐段转换后用 . 连接 → 二.一 / 02.01；不带格式时行为与旧版逐字一致。 */
    var CIRCLED_20 = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
    var CN_DIG = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    var CN_UP = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
    var CN_UNIT = ["", "十", "百", "千"];
    var CN_UNIT_UP = ["", "拾", "佰", "仟"];

    function toCn(n, upper) {
        var dg = upper ? CN_UP : CN_DIG, un = upper ? CN_UNIT_UP : CN_UNIT;
        n = Math.floor(Number(n));
        if (!isFinite(n) || n <= 0) return String(n);
        var s0 = String(n);
        if (s0.length > 4) return s0;          // 编号不会到万，超了原样输出
        var out = "", zero = false;
        for (var i = 0; i < s0.length; i++) {
            var d = Number(s0.charAt(i)), u = un[s0.length - 1 - i];
            if (d === 0) { zero = true; continue; }
            if (zero && out) out += dg[0];
            zero = false;
            out += dg[d] + u;
        }
        /* 小写习惯：11 → 十一（不是一十一）；大写要保留「壹拾」，所以只对 cn 生效 */
        if (!upper && out.indexOf("一十") === 0) out = out.slice(1);
        return out;
    }

    function toAlpha(n) {
        n = Math.floor(Number(n));
        if (!isFinite(n) || n <= 0) return String(n);
        var s0 = "";
        while (n > 0) {
            var r = (n - 1) % 26;
            s0 = String.fromCharCode(97 + r) + s0;
            n = Math.floor((n - 1) / 26);
        }
        return s0;
    }

    var ROMAN_MAP = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
                     [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    function toRoman(n) {
        n = Math.floor(Number(n));
        if (!isFinite(n) || n <= 0 || n > 3999) return String(n);
        var out = "";
        for (var i = 0; i < ROMAN_MAP.length; i++) {
            while (n >= ROMAN_MAP[i][0]) { out += ROMAN_MAP[i][1]; n -= ROMAN_MAP[i][0]; }
        }
        return out;
    }

    function padNum(v, width) {
        var s0 = String(v);
        while (s0.length < width) s0 = "0" + s0;
        return s0;
    }

    function fmtOne(v, fmt) {
        var f = String(fmt == null ? "" : fmt);
        if (!f) return String(v);
        if (/^0\d+$/.test(f)) return padNum(v, Number(f.slice(1)));
        if (f === "cn") return toCn(v, false);
        if (f === "CN") return toCn(v, true);
        if (f === "a") return toAlpha(v);
        if (f === "A") return toAlpha(v).toUpperCase();
        if (f === "o" || f === "①") {
            var n = Number(v);
            return (n >= 1 && n <= 20) ? CIRCLED_20.charAt(n - 1) : "(" + v + ")";
        }
        if (f === "i") return toRoman(v);
        if (f === "I") return toRoman(v).toUpperCase();
        return String(v);
    }

    /** 1 / 2.1 这类号按格式输出；复合号逐段转换后仍用 . 连。 */
    function formatNum(value, fmt) {
        var s0 = String(value == null ? "" : value);
        if (!fmt || !s0) return s0;
        return s0.split(".").map(function (seg) { return fmtOne(seg, fmt); }).join(".");
    }

    /** 该格式在「已编号标题」里可能长什么样 —— 剥旧号正则用，缺了它会叠成「一第一章」。 */
    function numPattern(fmt) {
        var f = String(fmt == null ? "" : fmt);
        if (!f) return "\\d+";
        if (/^0\d+$/.test(f)) return "\\d{" + Number(f.slice(1)) + ",}";
        if (f === "cn" || f === "CN") return "[零〇一二三四五六七八九十百千壹贰叁肆伍陆柒捌玖拾佰仟]+";
        if (f === "a" || f === "A") return "[A-Za-z]+";
        if (f === "o" || f === "①") return "[①-⑳]";
        if (f === "i" || f === "I") return "[ivxlcdmIVXLCDM]+";
        return "\\d+";
    }

    /** 复合号（{fn3} = 2.1.3、{fn} 同）：剥号时要允许段之间的点。 */
    function numPatternAll(fmt) {
        var one = numPattern(fmt);
        return one + "(?:\\." + one + ")*";
    }

    /** 把模板的「非 {title} 段」转成正则（带 :格式 时按格式生成字符类）。 */
    function wildcard(seg) {
        var out = "", last = 0, m;
        var re = /\{(parentNN|parentN|prefix|nn|n|title|fn[1-5]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g;
        while ((m = re.exec(seg)) !== null) {
            out += escapeRe(seg.slice(last, m.index));
            var k = m[1], fmt = m[2] || "";
            if (k === "title") out += "";
            else if (fmt) out += numPatternAll(fmt);
            else if (k === "nn" || k === "parentNN") out += "\\d{2,}";
            else if (k === "n" || k === "parentN") out += "\\d+";
            /* {fnK} / {hnK} 是「第 K 级完整号」，天然可能带点（2.1.3）——v0.7.0 在这里写成 \d+
             * 会只剥掉「2」，旧号越滚越长；v0.7.1 改为允许点。 */
            else out += "\\d+(?:\\.\\d+)*";
            last = m.index + m[0].length;
        }
        return out + escapeRe(seg.slice(last));
    }

    /** 由一条模板生成剥离规则：{title} 前 → ^前缀；{title} 后 → 后缀$。
     *  前缀和后缀要成对记，见 stripByFormats 里「只有前缀命中才剥后缀」的保护。 */
    function templateStripRules(tpl, level) {
        var s = normalizeTemplate(tpl, level);
        var i = s.indexOf(TITLE_TOKEN);
        var head = s.slice(0, i);
        var tail = s.slice(i + TITLE_TOKEN.length);
        var out = [];
        try {
            var h = /\S/.test(head) ? new RegExp("^" + wildcard(head)) : null;
            var t = /\S/.test(tail) ? new RegExp(wildcard(tail) + "$") : null;
            if (h || t) out.push({head: h, tail: t});
        } catch (e) { /* 模板里有奇怪字符时忽略这条，其余照常 */ }
        return out;
    }

    /** 兼容旧导出：把成对规则摊平成正则数组。 */
    function templateStripRegexes(tpl, level) {
        return templateStripRules(tpl, level).reduce(function (a, r) {
            if (r.head) a.push(r.head);
            if (r.tail) a.push(r.tail);
            return a;
        }, []);
    }

    /** 取「标题上真正显示出来的那个号」。
     *  v0.8.3：属性号原来存的是**全链号**（2.1.1.1），而标题用的是该级模板渲染出来的号
     *  （`{parentN}.{n}` → `1.1`）。正文编号照着属性拼 → `2.1.1.1.1`，越深越长。
     *  用户口径：**文档标题是 1.1，内容就是 1.1.1** —— 所以属性要存标题上那个号。
     *  取法：从渲染结果里读开头那串数字（允许「第 / 【 / ( / 空格」等装饰）；
     *  读不到（如中文数字模板）才退回全链号。 */
    function titleNum(title, fallback) {
        var s = String(title == null ? "" : title);
        var m = /^[\s【\[（(]*第?\s*(\d{1,4}(?:\.\d{1,4})*)/.exec(s);
        if (m) return m[1];
        return fallback == null ? "" : String(fallback);
    }

    /** 从模板推断「本级号」的补零宽度：{nn} → 2；{n:03} → 3；{n} → 0（不补）。
     *  v0.8.0：正文编号要用属性里存的纯号，而用户模板可能要求 `03` 这种补零形态，
     *  只存数字 `3` 就会和文档标题对不上，所以把宽度一起记下来。 */
    function padWidthOf(tpl) {
        var t = String(tpl == null ? "" : tpl);
        if (/\{nn\}/.test(t)) return 2;
        var m = /\{n:(0\d+)\}/.exec(t);
        if (m) return Number(m[1].slice(1));
        return 0;
    }

    /** 用模板生成标题。base 只作为 {title} 的值插入，不会再被扫描替换。
     *  ctx.parentIndex = 上一级文档的编号（供「第{parentN}.{n}节」），没有时为 0。
     *  ctx.fn / ctx.hn = 文档树 / 内容各级序号数组（下标 1~5），v0.7.0 新增。
     *      {fnK} = 第 K 级的序号（单个整数，1.1.1.4 → fn4=4）；{fn} = 从第 1 级连到本级的完整号（1.1.1.4）。
     *      旧写法全部保留为别名：{n}={fn本级}、{nn}=补零、{parentN}={fn上一级}。
     *  ctx.fallback     = 空模板时回退的模板表（插件层传 BUILTIN_V4_FORMATS）。 */
    function renderTemplate(tpl, level, index, base, ctx) {
        var c = ctx || {};
        var s = normalizeTemplate(tpl, level, c.fallback);
        var n = String(index);
        var nn = n.padStart(2, "0");
        var pv = (c.parentIndex == null || !isFinite(Number(c.parentIndex)))
            ? 0 : Number(c.parentIndex);
        var pn = String(pv), pnn = pn.padStart(2, "0");
        var fnArr = c.fn || [], hnArr = c.hn || [];
        /* v0.8.5：{fnK} / {hnK} = 第 K 级的**单个序号**（1.1.1.4 → fn1=1、fn2=1、fn3=1、fn4=4）。
         * 旧语义「前 K 级连号」（fn2=1.1）已废弃——那样没法自由组合，且 fn4 会等于整条号。
         * 要完整号写 {fn1}.{fn2}.{fn3}.{fn4}，或直接用 {fn}。
         * 缺级返回空串，绝不拼出半截号。 */
        function pick(arr, k) {
            var v = (arr || [])[k];
            if (v == null || v === "" || Number(v) === 0) return "";
            return String(v);
        }
        function joined(arr) {
            var out = [];
            for (var i = 1; i <= MAX_LEVEL; i++) {
                var v = (arr || [])[i];
                if (v == null || v === "" || Number(v) === 0) break;
                out.push(String(v));
            }
            return out.join(".");
        }
        return s.replace(/\{(parentNN|parentN|prefix|nn|n|title|fn[1-5]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g,
            function (m, k, fmt) {
            var f = fmt || "";
            if (k === "title") return String(base == null ? "" : base);
            /* v0.8.6：{prefix} = **上一级文档实际显示的号**（父文档标题上的号，如 1.1.1）。
             * 与正文模板侧的 {prefix}（本文档显示号）不同义 —— 那边是「我这篇的号」，
             * 这边是「我头上那篇的号」，因为本文档的号此刻正在生成，自引用会死循环。
             * 范围根没有父号 → 空串（第 1 级不要用 {prefix}）。 */
            if (k === "prefix") return formatNum(c.parentNum == null ? "" : String(c.parentNum), f);
            if (k === "nn") return f ? formatNum(index, f) : nn;
            if (k === "parentN") return f ? formatNum(pv, f) : pn;
            if (k === "parentNN") return f ? formatNum(pv, f) : pnn;
            if (k === "n") return f ? formatNum(index, f) : n;
            if (k === "fn") return formatNum(joined(fnArr) || n, f);
            if (k === "hn") return formatNum(joined(hnArr), f);
            if (k.charAt(0) === "f") return formatNum(pick(fnArr, Number(k.charAt(2))), f);
            if (k.charAt(0) === "h") return formatNum(pick(hnArr, Number(k.charAt(2))), f);
            return "";
        });
    }

    /**
     * 按「当前格式 + 上次格式 + 全局默认 + 内置默认 + 旧版硬编码」逐个剥旧编号。
     * 手写「第1章」不匹配 {nn} 生成的 \d{2,}，保持原样（Q2）。
     * 成对规则：模板有前缀时，只有前缀命中才允许剥后缀 —— 否则
     * 「{n}【{title}】」会把用户手写标题末尾的「】」误当成编号后缀剥掉。
     */
    /* 残缺括号：数字后面直接跟着右括号（`3】` / `3）` / `3)`）。
     * 2026-11-07 真机事故根因就是这个：用户把第 1 级模板改成「【{title}】」（head 只有字面量「【」，
     * 不含数字），剥号时它抢在「【{n}】{title}」前面把「【3】Tidyverse教程」的「【」剥掉，
     * 剩「3】Tidyverse教程」—— 此后任何规则都匹配不上，永久坏掉（【教材与专著】5 章同时中招）。
     * 只在最后兜底用：\d{1,3} 限 3 位，所以「2024）年度总结」这种 4 位年份不受影响。 */
    /* 兜底残渣（v0.8.2 扩写）：模板规则没覆盖到的「显式编号形态」，轮到它们。
     * 都只认**开头**、数字限 1~3 位，所以「2024 年度总结」「3 个方法」不会被误伤。 */
    var RESIDUE_RES = [
        /^第\s*\d{1,3}\s*[篇部章节条]\s*/,          // 第3篇 / 第2部 / 第1章（旧默认、历史默认）
        /^【\s*\d{1,3}\s*】\s*/,                    // 【3】
        /^\d{1,3}\s*[】）)]\s*/,                      // 3】 / 3） / 3)  （残缺括号）
        /^[（(]\s*\d{1,3}\s*[）)]\s*/,               // （3） / (3)
        /^\d{1,3}\s*[、．:]\s*/,                      // 3、 / 3． / 3:
        /^\d{1,3}\s+(?=[【（(\[])/                  // 3 【…（数字与括号之间有空格的写法）
    ];
    var RESIDUE_RE = RESIDUE_RES[2];   // 兼容旧引用

    /** 无条件脱掉最外层一对【】（仅用于「模板自己也用【】包标题」的场合：
     *  模板会重新加上括号，所以这里脱掉是幂等安全的）。
     *  与 unwrapBrackets 的区别：后者只在明显「叠了两层」时才脱。 */
    function stripOuterBrackets(s) {
        var t = String(s == null ? "" : s);
        var m = /^\s*【\s*([\s\S]*?)\s*】\s*$/.exec(t);
        return m ? m[1] : t;
    }

    function unwrapBrackets(s) {
        var t = String(s == null ? "" : s);
        var m = /^\s*【\s*([\s\S]*?)\s*】\s*$/.exec(t);
        if (!m) return t;
        var inner = m[1];
        /* 只在「内层自己也是括号组」时才脱 —— 即明显是叠了两层：
         *   【【AI】】 → 【AI】      【1】【陈若涵】 走残渣规则先剥 【1】
         * 普通的【审稿意见】这类用户自己的方括号**不动**。 */
        return /】\s*$/.test(inner) ? inner : t;
    }

    /** 剥离规则的优先级：head/tail 里含数字的（能标识「这是编号」）优先于纯字面量。
     *  没有这个排序，短字面量模板会抢剥长模板的完整形态（就是上面那个事故）。 */
    function ruleScore(r) {
        var d = (r.head && /\\d/.test(r.head.source)) ? 2 : 0;
        var t = (r.tail && /\\d/.test(r.tail.source)) ? 1 : 0;
        return d + t;
    }

    function stripByFormats(title, formatsList) {
        var s = String(title || "");
        var solos = [PREFIX_RE];
        var rules = [];
        (formatsList || []).forEach(function (f) {
            for (var lv = 1; lv <= MAX_LEVEL; lv++) {
                if (f && f[lv]) rules = rules.concat(templateStripRules(f[lv], lv));
            }
        });
        /* 先剥「带数字的具体形态」（【3】、第3章），再剥「纯字面量形态」（【）——
         * 否则后者会把前者的左括号吃掉，留下 `3】` 这种谁也认不出的残渣。 */
        rules.sort(function (a, b) { return ruleScore(b) - ruleScore(a); });
        var guard = 0, changed = true;
        while (changed && guard++ < 8) {
            changed = false;
            for (var i = 0; i < solos.length; i++) {
                if (solos[i].test(s)) { s = s.replace(solos[i], ""); changed = true; }
            }
            for (var j = 0; j < rules.length; j++) {
                var r = rules[j];
                var hit = r.head && r.head.test(s);
                if (hit) { s = s.replace(r.head, ""); changed = true; }
                if (r.tail && (!r.head || hit) && r.tail.test(s)) {
                    s = s.replace(r.tail, ""); changed = true;
                }
            }
            /* 兜底：模板规则没覆盖到的显式编号形态（第3篇 / 【3】 / 3】 / （3） / 3、），
             * 一律在这里剥掉 —— 这是「切换编号前先把老号剔干净」的最后一道保险。 */
            for (var ri = 0; ri < RESIDUE_RES.length; ri++) {
                if (RESIDUE_RES[ri].test(s)) { s = s.replace(RESIDUE_RES[ri], ""); changed = true; }
            }

        }
        return s;
    }

    /* 思源新建文档时的占位标题。这些标题不参与编号，也不占号；
     * 等用户把标题改成有意义的名字（发 rename 事件）后自动补编号。
     * 否则会写出「第03章 无标题」，且用户正在输标题时会被插件抢着改。
     * 2026-11-07 13:15 用户追加：跳过「无命名文档」（以及「未命名文档」等同义占位名）。 */
    var PLACEHOLDER_TITLES = [
        "", "无标题", "Untitled", "untitled",
        "无命名", "无命名文档", "未命名", "未命名文档",
        "新建文档", "New Document",
    ];
    /* 覆盖「无标题 2」「未命名文档3」「Untitled 4」这类带序号的占位名；
     * 要求整串匹配，不会误伤「未命名文档的整理思路」这种真实标题。 */
    var PLACEHOLDER_RE = /^(?:无标题|无命名|未命名|Untitled|新建文档|New Document)(?:\s*文档)?(?:\s*\d+)?$/i;

    /* ws-main 里会导致文档树结构 / 顺序变化的 cmd（探针实测见 probe/自动触发事件实测.md）。
     * savedoc / transactions / databaseIndexCommit / syncPending / statusbar / backgroundtask
     * 一律忽略 —— 打字会高频发这些，不能在用户写作时反复重排。 */
    var STRUCT_CMDS = {
        "create": 1,
        "removeDoc": 1,
        "removeDocByID": 1,
        "rename": 1,
        "filetreeSortChanged": 1,
        "moveDoc": 1,
        "moveDocs": 1,
        "refreshFiletree": 1,
        "filetree": 1,
    };

    function isConflict(title) {
        return CONFLICTED_RE.test(String(title || ""));
    }

    function isPlaceholder(title) {
        var s = String(title == null ? "" : title).trim();
        return PLACEHOLDER_TITLES.indexOf(s) >= 0 || PLACEHOLDER_RE.test(s);
    }

    /** 旧接口：只用内置硬编码正则剥（单测与历史代码兼容）。带格式的场景用 stripByFormats。 */
    function stripPrefix(title) {
        var s = String(title || "");
        var guard = 0;
        while (PREFIX_RE.test(s) && guard++ < 8) {
            s = s.replace(PREFIX_RE, "");
        }
        return s;
    }

    /** 不传 formats 时走核心内置模板，前三级输出与 v0.2.0 逐字一致，原单测不用改。 */
    function makeTitle(level, index, base, formats, ctx) {
        var f = (formats && formats[level]) || DEFAULT_FORMATS[level] || DEFAULT_FORMATS[3];
        return renderTemplate(f, level, index, base, ctx);
    }

    /** 按 listDocsByPath 返回的真实顺序排同级；没给顺序就保持传入顺序。 */
    function orderChildren(nodes, order) {
        var arr = (nodes || []).slice();
        if (!Array.isArray(order) || !order.length) return arr;
        var pos = new Map();
        order.forEach(function (id, i) { pos.set(id, i); });
        return arr.sort(function (a, b) {
            var ia = pos.has(a.id) ? pos.get(a.id) : 9999;
            var ib = pos.has(b.id) ? pos.get(b.id) : 9999;
            return ia - ib;
        });
    }

    function isStructuralCmd(cmd) {
        return !!STRUCT_CMDS[String(cmd || "")];
    }

    /**
     * 生成改名清单。root 是范围根（文档或虚拟笔记本根），root.children 是一级子文档。
     * 返回 [{id, from, to, level, index}]，只包含标题确实要变的项（保证幂等）。
     */
    /* v0.8.9：编号元数据统一存进一个 JSON 块属性，别的插件可一次读全。
     * v0.9.0：加 targetId，标记该文档属于编号插件的哪个范围配置（targets[].id），
     * 供 xref 按不同编号体系分别设定章节前缀层级。
     * v0.9.1：CustomNum / CurrentNum 实测没有任何消费方（xref 不读，本插件编号靠
     * custom-doc-num / custom-doc-pad 两个独立属性），删掉只留 3 个必需字段。
     * 旧文档里残留的这 2 个字段不会被重写，读的一方忽略即可。 */
    const META_ATTR = "custom-doc-num-meta";
    function docNumMeta(rootID, rootNum, targetId) {
        return JSON.stringify({
            rootID: String(rootID || ""),
            rootNum: String(rootNum || ""),
            targetId: String(targetId || ""),
        });
    }
    /** SQL 的 blocks.ial 把 JSON 存成 HTML 实体（&#123; / &quot; / &#125;），读回来要反转义。 */
    function decodeIalText(s) {
        return String(s == null ? "" : s)
            .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    function parseIalMeta(ial) {
        const m = /custom-doc-num-meta="([^"]*)"/.exec(String(ial || ""));
        if (!m) return null;
        try {
            const o = JSON.parse(decodeIalText(m[1]));
            return o && typeof o === "object" ? o : null;
        } catch (e) { return null; }
    }
    /** notebook 范围下 t.id 是笔记本 ID；「顶级文档」取 path 第一段。 */
    function topDocIdOf(path) {
        const first = String(path || "").replace(/^\/+/, "").split("/")[0];
        return first.replace(/\.sy$/, "");
    }

    function buildPlan(root, opt) {
        var out = [];
        var o = opt || {};
        var skipPlaceholder = o.skipPlaceholder !== false;   // 顶栏可关掉
        var skipIds = new Set(o.skipIds || []);              // 排除文档自身，子文档仍编号
        var skipSubtreeIds = new Set(o.skipSubtreeIds || []); // 排除整支，整支原样不编号
        var activeFormats = normalizeFormats(o.formats);   // 当前模板本身也要进剥离清单
        var counters = normalizeCounters(o.counters);       // 每级 global / local / grandlocal
        var maxLevel = clampLevel(o.maxLevel || DEFAULT_MAX_LEVEL);  // 1~5 级
        /* 剥旧前缀时要试的模板：当前 + 调用方给的（上次 / 各范围自己的历史）
         * + **全部历史内置模板**。切换编号方案时，老号必须在这之前就被剔干净。 */
        var stripList = [activeFormats].concat(o.stripFormats || []).concat(HISTORY_FORMATS);
        function stripAny(title) { return stripByFormats(title, stripList); }

        /** 剥掉一整支的插件编号前缀（排除整支 / 超出层级数时），不改树结构。
         *  手写「第1章」不匹配内置 \d{2,}，保持原样。 */
        function stripBranch(node, reason, onlySelf) {
            var base = stripAny(node.title);
            if (base !== node.title) {
                out.push({id: node.id, from: node.title, to: base,
                          level: 0, index: 0, reason: reason});
            }
            if (onlySelf) return;   // 单篇排除时子文档仍要编号，别把它们的前缀也剥掉
            orderChildren(node.children || [], node.order).forEach(function (c) {
                stripBranch(c, reason, false);
            });
        }

        var serial = {};   // global：每层一个全书流水号
        var grand = {};    // grandlocal：level + 祖父节点 id 一个流水号
        /* ancestorId  = node 的父节点 id，也就是 node 的孩子们（level 级）的「上上级」。
         * parentIndex = node 自己的编号，供 {parentN} 渲染（第1.1节里的前一个 1）。
         * chain       = 从根到当前节点各层的序号（下标 1~5），供 {fn1}~{fn5} 与 {fn} 组合。 */
        function walk(node, level, ancestorId, parentIndex, chain, parentNum) {
            if (level > maxLevel) {
                /* 减少层级后：超出的文档恢复原标题。只剥 node 的子孙 ——
                 * node 自身是刚编好号的上级，不能把它自己的前缀也剥掉。 */
                orderChildren(node.children || [], node.order).forEach(function (c) {
                    stripBranch(c, "beyond", false);
                });
                return;
            }
            var kids = orderChildren(
                (node.children || []).filter(function (n) { return !isConflict(n.title); }),
                node.order
            );
            var local = 0;
            var gkey = level + "|" + String(ancestorId == null ? "root" : ancestorId);
            for (var k = 0; k < kids.length; k++) {
                var kid = kids[k];
                if (skipSubtreeIds.has(kid.id)) { stripBranch(kid, "excluded", false); continue; }
                if (skipIds.has(kid.id)) {
                    stripBranch(kid, "excluded", true);
                    walk(kid, level + 1, node.id, null, chain, "");
                    continue;
                }
                /* v0.8.0：剥号后要去掉首尾空白。标题 `01【 个人简介】` 剥出「 个人简介」（带前导空格），
                 * 套 `{nn}【 {title}】` 模板就多出一个空格 → `01【  个人简介】`（9 篇真机踩到）。 */
                var base = stripAny(kid.title).trim();
                /* 模板自己也用【】包标题（如 `{n:02}【{title}】`）时，标题里若已经带着一对
                 * 完整方括号，会叠成 `01【【陈若涵】】` —— 这里先脱一层。只在模板包标题时做，
                 * 所以 `第{n}章 【审稿意见】` 这种不受影响（模板不包括号，用户括号原样保留）。 */
                if (/【\s*\{title\}/.test(String(activeFormats[level] || ""))) {
                    base = stripOuterBrackets(base);
                }
                // 占位标题 / 剥完为空：不编号、不占号，但下级仍要遍历（层级不能断）
                var isEmptyBase = !base.trim();
                var isPhTitle = skipPlaceholder && (isPlaceholder(kid.title) || isPlaceholder(base));
                if (isEmptyBase || isPhTitle) {
                    // 已经带过编号的占位文档（如「第01部 未命名文档」）把旧号剥掉，
                    // 否则用户看到「跳过」却还挂着一个旧编号；改好名字后会自动补号。
                    // 剥完为空的不动 —— 不能把文档改成空标题（A8 守护）。
                    if (!isEmptyBase && isPhTitle && base !== kid.title) {
                        out.push({id: kid.id, from: kid.title, to: base,
                                  level: 0, index: 0, reason: "placeholder"});
                    }
                    walk(kid, level + 1, node.id, null, chain, "");
                    continue;
                }
                var idx;
                if (counters[level] === "local") { local++; idx = local; }
                else if (counters[level] === "grandlocal" && ancestorId != null) {
                    grand[gkey] = (grand[gkey] || 0) + 1; idx = grand[gkey];
                } else { serial[level] = (serial[level] || 0) + 1; idx = serial[level]; }
                var myChain = (chain || []).slice();
                myChain[level] = idx;
                var to = makeTitle(level, idx, base, activeFormats,
                                   {parentIndex: parentIndex, fn: myChain, parentNum: parentNum});
                /* v0.8.0：同时算出「这个节点的纯号」（1.3 这种数字链）与补零宽度，
                 * 由插件写进文档属性 custom-doc-num —— 正文编号以后只认属性，不再猜标题形态。 */
                var fullChain = myChain.slice(1, level + 1).join(".");
                /* 属性存「标题上显示的号」：`1.1 安装与配置` → 1.1；`02【数据统计与分析】` → 02；
                 * `第1章 【R学习】` → 1。这样正文 {fn}.{n} 才能拼出用户要的 1.1.1。 */
                var myNum = titleNum(to, fullChain);
                var padW = padWidthOf(activeFormats[level]);
                /* v0.8.9：emitMeta 时把完整链 / 本级序号 / path 带出来，供插件写
                 * custom-doc-num-meta。fullChain 来自 myChain，只含「根→父→父父→本篇」
                 * 这条祖先链，不含同级和其它分支，也没有额外查询。
                 * 挂到节点上是为了「补齐」入口能遍历整棵树；默认关闭 →
                 * 现有离线单测的 plan 结构逐字不变。 */
                if (o.emitMeta) {
                    kid.chain = fullChain;
                    kid.current = idx;
                    kid.metaNum = myNum;
                    var extra = {chain: fullChain, current: idx, path: kid.path || ""};
                    if (to !== kid.title) {
                        out.push(Object.assign({id: kid.id, from: kid.title, to: to, level: level,
                            index: idx, num: myNum, pad: padW}, extra));
                    } else if (o.writeAttrs && (kid.num !== myNum || kid.pad !== padW)) {
                        out.push(Object.assign({id: kid.id, from: kid.title, to: kid.title, level: level,
                            index: idx, num: myNum, pad: padW, attrOnly: true}, extra));
                    }
                } else if (to !== kid.title) {                  // 幂等：标题已对就不进清单
                    out.push({id: kid.id, from: kid.title, to: to, level: level, index: idx,
                              num: myNum, pad: padW});
                } else if (o.writeAttrs && (kid.num !== myNum || kid.pad !== padW)) {
                    /* 标题没变但属性可能缺 / 过期（老文档、换过模板）→ 也要进清单，
                     * 让插件补写属性。这类项 to === from，插件只写属性不改名。 */
                    out.push({id: kid.id, from: kid.title, to: kid.title, level: level,
                              index: idx, num: myNum, pad: padW, attrOnly: true});
                }
                walk(kid, level + 1, node.id, idx, myChain, myNum);  // 下级继续编号；超出层级时改剥前缀
            }
        }
        walk(root, 1, null, null, [], "");
        return out;
    }

    /**
     * 由一次 SQL 的结果建树（旧路径，保留兼容）。path 是「文档 ID 路径」。
     * rootInfo: {id, content, path}；rows: [{id, content, path}]
     */
    function buildTreeFromRows(rootInfo, rows) {
        var byPath = {};
        var nodes = [];
        var root = {
            id: rootInfo.id,
            title: rootInfo.content || "",
            path: rootInfo.path,
            children: [],
            order: null,
        };
        byPath[rootInfo.path] = root;
        (rows || []).forEach(function (r) {
            if (isConflict(r.content)) return;          // 排除 Syncthing 冲突副本
            var node = {id: r.id, title: r.content || "", path: r.path, children: [], order: null};
            byPath[r.path] = node;
            nodes.push(node);
        });
        nodes.forEach(function (n) {
            var dir = n.path.slice(0, n.path.lastIndexOf("/"));
            var parent = byPath[dir + ".sy"] || root;
            parent.children.push(n);
        });
        return root;
    }

    /**
     * Q7 新增：把 listDocsByPath 的一次返回转成子节点。
     * files 数组顺序 = 文档树当前自定义排序（拖动后的顺序），name = 实时标题，
     * subFileCount = 该文档是否有子文档（用来决定要不要继续递归，叶子不能调接口）。
     */
    function childrenFromFiles(parentPath, files) {
        var base = String(parentPath || "").replace(/\.sy$/, "");
        if (base === "" || base === ".") base = "";
        var arr = [];
        (files || []).forEach(function (f) {
            if (!f || !f.id || isConflict(f.name)) return;
            arr.push({
                id: f.id,
                title: f.name || "",
                path: f.path || (base + "/" + f.id + ".sy"),
                sort: f.sort,
                subFileCount: Number(f.subFileCount) || 0,
                children: [],
                order: null,
            });
        });
        return {children: arr, order: arr.map(function (n) { return n.id; })};
    }

    /** listDocsByPath 的 path 参数：文档用 ID 路径去掉 .sy；笔记本根用 "/" */
    function pathForList(nodePath) {
        var p = String(nodePath || "").replace(/\.sy$/, "");
        return p === "" ? "/" : p;
    }

    /** ordersByPath: { "<path 去掉 .sy>": [id, id, ...] }，来自 listDocsByPath。 */
    function applyOrderTree(root, ordersByPath) {
        (function walk(n) {
            var key = n.path.replace(/\.sy$/, "");
            if (ordersByPath && ordersByPath[key]) n.order = ordersByPath[key];
            (n.children || []).forEach(walk);
        })(root);
        return root;
    }

    /**
     * 用 listDocsByPath 返回的实时 name 覆盖 SQL 读到的标题（旧路径兼容保留）。
     */
    function applyNames(root, names) {
        (function walk(n) {
            if (names && names[n.id]) n.title = names[n.id];
            (n.children || []).forEach(walk);
        })(root);
        return root;
    }

    /** 需要为哪些节点调 listDocsByPath（旧路径兼容保留）。 */
    function nodesNeedingOrder(root) {
        var out = [];
        (function walk(n) {
            if ((n.children || []).length) {
                out.push(n);
                (n.children || []).forEach(walk);
            }
        })(root);
        return out;
    }

    /**
     * 结构指纹：把「层级 + ID + 实时标题 + 同级自定义顺序」压成一个字符串。
     * 自动编号靠它判断「这次事件是否真的改变了树」，避免打字、重复广播、自己改名引发空转写入。
     */
    function fingerprint(root) {
        var parts = [];
        (function walk(n, depth) {
            parts.push(depth + ":" + n.id + ":" + String(n.title || ""));
            parts.push("o" + depth + ":" + (n.order || []).join(","));
            orderChildren(n.children || [], n.order).forEach(function (c) { walk(c, depth + 1); });
        })(root, 0);
        return parts.join("|");
    }

    /** filetreeSortChanged 事件自带新顺序；提取成 {parentPath: [id...]} 供采集时优先采用。 */
    function orderFromSortEvent(data) {
        var d = data || {};
        if (!d.parentPath || !Array.isArray(d.childIDs) || !d.childIDs.length) return null;
        return {parentPath: String(d.parentPath).replace(/\.sy$/, ""), ids: d.childIDs.slice()};
    }

    var api = {
        LABELS: LABELS,
        PREFIX_RE: PREFIX_RE,
        MAX_LEVEL: MAX_LEVEL,
        DEFAULT_MAX_LEVEL: DEFAULT_MAX_LEVEL,
        DEFAULT_FORMATS: DEFAULT_FORMATS,
        DEFAULT_COUNTERS: DEFAULT_COUNTERS,
        BUILTIN_V4_FORMATS: BUILTIN_V4_FORMATS,
        BUILTIN_V4_COUNTERS: BUILTIN_V4_COUNTERS,
        BUILTIN_V4_MAX_LEVEL: BUILTIN_V4_MAX_LEVEL,
        COUNTER_MODES: COUNTER_MODES,
        normalizeFormats: normalizeFormats,
        normalizeCounters: normalizeCounters,
        clampLevel: clampLevel,
        normalizeTemplate: normalizeTemplate,
        renderTemplate: renderTemplate,
        templateStripRules: templateStripRules,
        templateStripRegexes: templateStripRegexes,
        stripByFormats: stripByFormats,
        PLACEHOLDER_TITLES: PLACEHOLDER_TITLES,
        STRUCT_CMDS: STRUCT_CMDS,
        isConflict: isConflict,
        isPlaceholder: isPlaceholder,
        isStructuralCmd: isStructuralCmd,
        stripPrefix: stripPrefix,
        makeTitle: makeTitle,
        orderChildren: orderChildren,
        formatNum: formatNum,
        numPattern: numPattern,
        numPatternAll: numPatternAll,
        padWidthOf: padWidthOf,
        titleNum: titleNum,
        HISTORY_FORMATS: HISTORY_FORMATS,
        DEFAULT_FORMATS: DEFAULT_FORMATS,
        stripOuterBrackets: stripOuterBrackets,
        buildPlan: buildPlan,
        buildTreeFromRows: buildTreeFromRows,
        childrenFromFiles: childrenFromFiles,
        pathForList: pathForList,
        applyOrderTree: applyOrderTree,
        applyNames: applyNames,
        nodesNeedingOrder: nodesNeedingOrder,
        fingerprint: fingerprint,
        orderFromSortEvent: orderFromSortEvent,
        // v0.8.9 编号元数据（一个 JSON 属性）
        META_ATTR: META_ATTR,
        docNumMeta: docNumMeta,
        decodeIalText: decodeIalText,
        parseIalMeta: parseIalMeta,
        topDocIdOf: topDocIdOf,
    };

    if (typeof globalThis !== "undefined") globalThis.DocNumbering = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
