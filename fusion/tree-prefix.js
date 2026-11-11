/* v1.1.2 B 方案：文档树编号「编号文本 / 用户文本」隔离层（纯函数，单测与生成物共用）。
 *
 * 起因（2026-11-11 用户报）：文档名「2025200013 王可」被自动重排剥成「王可」，
 * 「2022200013  韩宏伟」同理；「第4篇」被剥成空串后不再编号。
 * 根因：树编号剥旧号只靠 stripByFormats 的宽泛正则（历史模板 {n} {title} → ^\d+ ），
 * 10 位学号被当成旧编号。正文侧 v1.1.1 已有 D 方案（custom-body-num 精确剥离），
 * 本模块把同一套思路搬到文档树侧。
 *
 * 做法：编号写入时给文档打三个属性，记录插件自己写进标题的「头 / 尾」装饰；
 * 下一轮剥号命中标记就精确切除，完全不跑正则。无标记的历史文档回退原逻辑，
 * 但先过 isProtected()：学号 / 年份 / 日期 / 纯数字开头一律原样保留。
 */
(function (g) {
    "use strict";

    var ATTR_OWNED = "custom-doc-num-owned";
    var ATTR_HEAD = "custom-doc-num-head";
    var ATTR_TAIL = "custom-doc-num-tail";

    /* 行首是「用户正文」而不是「插件编号」的形态：
     *   - 10 位学号等 ≥5 位连续数字，后跟空白 / 汉字 / 结束（2025200013 王可、2024200018于佳立）
     *   - 4 位年份，后跟「年」/ 汉字 / -/. + 数字（2023年投稿情况、2026-10-14 …）
     *   - N月N日
     *   - 纯数字（222）—— 04j 2026-11-09 同类坑的既定口径
     * 复合编号 1.2.3.4.5 不匹配（第 5 位后是点号），不会误伤真编号。 */
    var RE_PROTECTED = /^\s*(?:\d{5,}(?=[\s\u4e00-\u9fff]|$)|\d{4}(?=[\s\u4e00-\u9fff]|[-/.]\s*\d{1,2})|\d{1,2}\s*月\s*\d{1,2}\s*日|\d+\s*$)/;

    function isProtected(title) {
        return RE_PROTECTED.test(String(title == null ? "" : title));
    }

    /** 由渲染结果 to 与剥号后的原文 base 算出插件写入的装饰。 */
    function ownDecor(to, base) {
        var s = String(to == null ? "" : to);
        var b = String(base == null ? "" : base);
        var i = b ? s.indexOf(b) : -1;
        if (i < 0) return {owned: "1", head: "", tail: ""};
        return {owned: "1", head: s.slice(0, i), tail: s.slice(i + b.length)};
    }

    /**
     * 剥掉文档名里的旧编号。
     * @param {string} title 当前文档标题
     * @param {object} own   从块属性读回的 {owned, head, tail}；无标记传 null
     * @param {function} fallbackStrip 无标记时回退的原剥号函数（接收 title，返回剥后文本）
     * @returns {{text:string, exact:boolean}} text 为剥号结果；exact=true 表示走了精确路径、调用方不应再跑正则
     */
    function peel(title, own, fallbackStrip) {
        var s = String(title == null ? "" : title);
        if (!s) return {text: s, exact: true};
        /* ① 插件自己的编号：按记录的头/尾精确切除，用户文本里的学号、年份、日期一概不碰。 */
        if (own && own.owned) {
            var h = String(own.head || "");
            var t = String(own.tail || "");
            if (!h || s.indexOf(h) === 0) {
                var rest = s.slice(h.length);
                if (t && rest.slice(-t.length) === t) rest = rest.slice(0, rest.length - t.length);
                return {text: rest, exact: true};
            }
            /* 用户手动改过标题、旧头不再匹配：仍不跑宽泛正则，按用户原文处理。 */
            return {text: s, exact: true};
        }
        /* ② 无标记的历史文档：学号 / 年份 / 日期 / 纯数字开头直接放行。 */
        if (isProtected(s)) return {text: s, exact: true};
        /* ③ 回退原正则；剥成空串则回退原文（「第4篇」「第5篇」因此能保住标题并正常编号）。 */
        var out = typeof fallbackStrip === "function" ? fallbackStrip(s) : s;
        if (!String(out == null ? "" : out).trim()) return {text: s, exact: true};
        return {text: out, exact: false};
    }

    /** 从 SQL 读回的 ial 文本里解析三个标记（属性值经思源 HTML 实体编码）。 */
    function parseOwn(ial, decode) {
        var s = String(ial || "");
        function grab(name) {
            var m = new RegExp(name + '="([^"]*)"').exec(s);
            if (!m) return "";
            return typeof decode === "function" ? decode(m[1]) : m[1];
        }
        var owned = grab(ATTR_OWNED);
        if (!owned) return null;
        return {owned: owned, head: grab(ATTR_HEAD), tail: grab(ATTR_TAIL)};
    }

    var api = {
        ATTR_OWNED: ATTR_OWNED, ATTR_HEAD: ATTR_HEAD, ATTR_TAIL: ATTR_TAIL,
        RE_PROTECTED: RE_PROTECTED,
        isProtected: isProtected, ownDecor: ownDecor, peel: peel, parseOwn: parseOwn,
    };
    /* 注意：本文件会被拼进 index.js 顶层，那里 module.exports 必须留给插件类，
     * 所以这里**只挂 globalThis**，绝不写 module.exports（单测同样读 globalThis）。 */
    if (g) g.MSTreePrefix = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
