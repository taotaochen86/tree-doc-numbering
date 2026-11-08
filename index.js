/* 子文档自动编号 v0.9.3 · 本文件由 build.py 生成，请勿手改
 * 源码：src/numbering.js（编号核心）+ src/plugin.js（插件主体）
 * 加载器用 window.eval 包 CommonJS → 只能写 module.exports = class extends Plugin
 */

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
const PLUGIN_VERSION = "0.9.3";

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
                    showMessage("正文编号失败：" + e.message, 8000, "error")),
            });
        }
        this._onBodyHotkey = (ev) => this.onBodyHotkey(ev);
        if (typeof document !== "undefined") {
            document.addEventListener("keydown", this._onBodyHotkey, true);
        }

        this._topBar = this.addTopBar({
            icon: MENU_ICON,
            title: "标题体系自动编号：读取中…",
            position: "right",
            callback: () => this.openPanel().catch((e) =>
                showMessage("面板打开失败：" + e.message, 6000, "error")),
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
                label: "编号：文档标题 + 内容标题",
                click: () => this.numberBoth(nbTarget).catch((e) =>
                    showMessage("编号失败：" + e.message, 8000, "error")),
            });
            this.addRangeMenuItem(detail.menu, nbTarget);
            detail.menu.addItem({type: "separator"});
            detail.menu.addItem({
                icon: "iconUndo",
                label: "撤销",
                submenu: [
                    {icon: "iconFiles", label: "撤销文档标题编号",
                     click: () => this.undoNumbering().catch((e) =>
                         showMessage("撤销失败：" + e.message, 8000, "error"))},
                    {icon: "iconFiles", label: "撤销内容标题编号",
                     click: () => this.undoBodyNumbering().catch((e) =>
                         showMessage("撤销失败：" + e.message, 8000, "error"))},
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
            label: "编号：文档标题 + 内容标题",
            click: () => this.numberBoth(target).catch((e) =>
                showMessage("编号失败：" + e.message, 8000, "error")),
        });
        detail.menu.addItem({
            icon: "iconRefresh",
            label: "只编号内容标题",
            click: () => this.numberBodyOnly(target).catch((e) =>
                showMessage("编号失败：" + e.message, 8000, "error")),
        });
        this.addRangeMenuItem(detail.menu, target);
        this.addExcludeMenuItems(detail.menu, target);
        detail.menu.addItem({type: "separator"});
        detail.menu.addItem({
            icon: "iconUndo",
            label: "撤销",
            submenu: [
                {icon: "iconFiles", label: "撤销文档标题编号",
                 click: () => this.undoNumbering().catch((e) =>
                     showMessage("撤销失败：" + e.message, 8000, "error"))},
                {icon: "iconFiles", label: "撤销内容标题编号",
                 click: () => this.undoBodyNumbering().catch((e) =>
                     showMessage("撤销失败：" + e.message, 8000, "error"))},
            ],
        });
    }

    /** 排除 / 取消排除收进一个子菜单，右键菜单不再被三个同义项撑长。 */
    addExcludeMenuItems(menu, target) {
        const cfg = this._config || DEFAULT_CONFIG;
        const found = (cfg.excluded || []).find((e) => e.id === target.id);
        const sub = found
            ? [{icon: "iconCheck", label: "取消排除（恢复参与编号）",
                click: () => this.toggleExclude(target, "off").catch((e) =>
                    showMessage("取消排除失败：" + e.message, 8000, "error"))}]
            : [{icon: "iconClose", label: "仅自身不编号（子文档照常）",
                click: () => this.toggleExclude(target, "self").catch((e) =>
                    showMessage("排除失败：" + e.message, 8000, "error"))},
               {icon: "iconClose", label: "整支不编号（含子文档）",
                click: () => this.toggleExclude(target, "subtree").catch((e) =>
                    showMessage("排除失败：" + e.message, 8000, "error"))}];
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
            showMessage(r.ok ? ("已给 " + (r.docsHit || 0) + " 篇、共 " + (r.changed || 0) + " 处内容标题编号")
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
            showMessage("已排除「" + name + "」" + (mode === "subtree" ? "及其子文档" : "（仅自身）")
                + "，编号已重排", 7000, "info");
        } else {
            showMessage("已取消排除「" + (target.name || target.id) + "」，编号已重排", 7000, "info");
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
                showMessage("设置失败：" + e.message, 8000, "error")),
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
            showMessage("已取消自动编号范围：" + target.name, 5000, "info");
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
        showMessage("已设为自动编号范围：" + target.name + "。现在新增 / 删除 / 拖动子文档会自动重排编号", 8000, "info");
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
            showMessage("编号设置已保存（" + next.maxLevel + " 级），已重排 " + reran + " 个范围", 6000,
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

        const dlg = new Dialog({title: "树文联动编号", content: html,
                                width: "640px", height: "min(92vh, 960px)"});
        const root = dlg.element;
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
                    showMessage("正文模板已切换，正在按新模板重排（会先剔除老编号）…", 4000, "info");
                    this.rerunBodyForSwitch({source: "format-switch"}).catch((e) =>
                        showMessage("正文重排失败：" + e.message, 9000, "error"));
                }
            } catch (e) {
                showMessage("编号设置保存失败：" + e.message, 8000, "error");
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
                    showMessage("已恢复内置正文模板，正在重排（会先剔除老编号）…", 4000, "info");
                    this.rerunBodyForSwitch({source: "format-reset"}).catch((e) =>
                        showMessage("正文重排失败：" + e.message, 9000, "error"));
                }
            } catch (e) {
                showMessage("恢复默认失败：" + e.message, 8000, "error");
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
            this.runAll({silent: false}).catch((e) => showMessage("重排失败：" + e.message, 8000, "error"));
            dlg.destroy();
        });
        const btnUndo = q("#dn-undo");
        if (btnUndo) btnUndo.addEventListener("click", () => {
            this.undoNumbering().catch((e) => showMessage("撤销失败：" + e.message, 8000, "error"));
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
                .catch((e) => showMessage("撤销失败：" + e.message, 8000, "error"));
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
                    showMessage(r.ok ? ("已给 " + r.docsHit + " 篇、共 " + r.changed + " 处正文标题编号")
                                     : ("批量编号中断，已改 " + r.changed + " 处，可点「撤销上次正文编号」回退"),
                                r.ok ? 6000 : 9000, r.ok ? "info" : "error");
                    this.refreshTopBar();
                    return;
                }
                const ids = await this.rangeDocIds();
                if (!ids.length) {
                    showMessage("还没有设置自动编号范围，先在上面「自动编号范围」里添加文档或笔记本", 7000, "info");
                    return;
                }
                const pre = await this.numberBodyRange(ids, {dryRun: true});
                if (!pre.total) {
                    showMessage("范围内 " + ids.length + " 篇的正文编号已是最新，无需改动", 6000, "info");
                    return;
                }
                this._bodyRunArmed = {ids: ids, ts: Date.now()};
                btnBRun.textContent = "确认写入 " + pre.total + " 处";
                showMessage("预检：" + pre.docsHit + " 篇、共 " + pre.total
                            + " 处标题要改。确认无误再点一次按钮写入（可整批撤销）", 10000, "info");
            } catch (e) {
                showMessage("正文批量编号失败：" + e.message, 9000, "error");
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
                if (!o.silent) showMessage("「" + info.content + "」下的子文档编号已是最新的，无需改动", 6000, "info");
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
                    showMessage("编号中断：已改 " + result.changed + " 篇，失败 1 篇（" + result.failed[0].error
                        + "）。右键「撤销上次子文档编号」可回退", 10000, "error");
                } else if (!result.verified) {
                    showMessage("已提交 " + result.changed + " 处改名，但回读校验超时，请刷新文档树确认", 9000, "error");
                } else {
                    showMessage("已给「" + info.content + "」下 " + result.changed
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
                showMessage("重排中断：" + (f.error || (f.failed[0] || {}).error || "未知错误")
                            + "。右键「撤销上次子文档编号」可回退", 10000, "error");
            } else {
                const bt = body
                    ? (body.ok ? "；正文 " + (body.docsHit || 0) + " 篇、" + (body.changed || 0) + " 处"
                               : "；正文失败：" + (body.error || ""))
                    : "；正文编号已关闭，只重排了文档标题";
                showMessage("文档树已重排 " + out.length + " 个范围、改 " + changed + " 个标题" + bt, 9000, "info");
            }
        }
        return {tree: out, body: body, meta: meta, changed: changed};
    }

    async undoNumbering(opt) {
        const o = opt || {};
        const raw = await this.loadData(UNDO_FILE);
        if (!raw) {
            if (!o.silent) showMessage("没有可撤销的上一轮编号", 5000, "info");
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
            showMessage((failed.length
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
            if (!o.silent) showMessage("正文编号快捷键已在设置里关闭", 6000, "info");
            return {ok: false, reason: "disabled"};
        }
        const ctx = o.context || this.currentBodyContext();
        if (!ctx || !ctx.blockId) {
            if (!o.silent) showMessage("请把光标放到正文段落里再按快捷键", 6000, "info");
            return {ok: false, reason: "no-cursor"};
        }
        const rows = await sql("SELECT root_id FROM blocks WHERE id='" + esc(ctx.blockId) + "' LIMIT 1");
        if (!rows.length || !rows[0].root_id) return {ok: false, reason: "no-doc"};
        const docId = rows[0].root_id;
        /* 光标落在编辑器根节点上（closest 拿到的是文档 ID）：绝不把 updateBlock 打到文档根 */
        if (ctx.blockId === docId) {
            if (!o.silent) showMessage("光标不在正文段落里，请点到具体段落再按快捷键", 6000, "info");
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
            if (!o.silent) showMessage("读不到当前段落的文字，未做任何改动，请把光标移回正文再试", 7000, "info");
            return {ok: false, reason: "empty-read", docId: docId, docTitle: docTitle};
        }
        /* 其它标题块读不到同样整篇跳过：否则它们不占号，后面标题会整体前移，下一轮又改回来 */
        const unread2 = ordered.filter((b) => mdMap.get(b.id) === null);
        if (unread2.length) {
            if (!o.silent) showMessage("有 " + unread2.length + " 个标题块暂时读不到内容，"
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
            if (!o.silent) showMessage("当前文档标题里没有节编号或章编号，已跳过正文编号", 7000, "info");
            return {ok: false, reason: "no-prefix", docId: docId, docTitle: docTitle};
        }
        if (!r.plan.length) {
            if (!o.silent) showMessage("正文标题编号已是最新，无需改动", 6000, "info");
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
                showMessage("正文编号中断：已改 " + changed + " 处，可用「撤销上次正文编号」回退", 9000, "error");
            } else {
                showMessage("已把当前段落设为 " + lv + " 级标题，并重排 " + changed + " 处正文编号", 7000, "info");
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
            showMessage(r.ok
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
            if (!o.silent) showMessage("没有可撤销的上一轮正文编号", 5000, "info");
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
            showMessage(failed.length
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
                                showMessage("《" + (r.docTitle || docId) + "》的正文编号连续 3 轮都算出不同结果，"
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
                showMessage("编号中断：" + (r.failed[0] || {}).error, 9000, "error");
            } else {
                showMessage("文档标题改 " + (r.changed || 0) + " 篇" + bt, 8000, "info");
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
            showMessage("正文自动编号中断：已改 " + changed + " 处，可用「撤销上次正文编号」回退", 9000, "error");
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
            if (failed.length) showMessage("正文批量编号中断：已改 " + changed + " 处，可用「撤销上次正文编号」整批回退", 9000, "error");
            else showMessage("已给 " + hit + " 篇、共 " + changed + " 处正文标题编号", 7000, "info");
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
            showMessage("正文编号失败：" + e.message, 8000, "error"));
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
                        showMessage("检测到编号在两套格式间反复切换（编号范围可能重叠），已暂停自动编号。"
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
