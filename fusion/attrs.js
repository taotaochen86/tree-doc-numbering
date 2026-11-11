/* v1.2.0：插件状态单属性层（纯函数，生成物 / 单测共用）。
 *
 * 起因（2026-11-11 用户报）：文档属性面板里一个文档挂了 5 条自定义属性
 *   doc-num / doc-num-head / doc-num-meta / doc-num-owned / doc-pad，
 * 正文标题块另有 body-num。要求「剔除冗余 + 所有属性放进一个 JSON 字符」。
 *
 * 做法：**沿用唯一属性名 custom-doc-num-meta**，值永远是一个 JSON 字符串。
 *   文档块：{"rootID":…, "rootNum":…, "targetId":…, "num":…, "pad":…, "head":…}
 *   标题块：{"bn":…}                     （bn = 插件写进正文标题的纯编号）
 * 前 3 个字段是 siyuan-xref 读的章节元数据，属性名与字段名都保持不变，
 * 因此交叉引用插件零改动、章节前缀层级功能不受影响。
 *
 * 剔除的冗余：
 *   owned —— 恒为 "1"，改由 head 是否存在表示；
 *   tail  —— 上线至今一条都没写过；
 *   pad   —— 值为 0 时不写（原来 329 篇里只有 64 篇非 0）。
 */
(function (g) {
    "use strict";

    var ATTR = "custom-doc-num-meta";
    var META_KEYS = ["rootID", "rootNum", "targetId"];
    var DOC_KEYS = ["num", "pad", "head"].concat(META_KEYS);
    /* 损坏 / 外部写入的属性值可能带这些键，直接赋值会改掉对象原型，一律跳过。 */
    var UNSAFE_KEYS = {"__proto__": 1, "constructor": 1, "prototype": 1};

    /** 解析一个属性值（可传 HTML 实体编码后的 ial 片段，decode 由调用方给）。 */
    function parse(raw, decode) {
        var s = String(raw == null ? "" : raw);
        if (typeof decode === "function") s = decode(s);
        if (!s.trim()) return null;
        try {
            var o = JSON.parse(s);
            return o && typeof o === "object" && !Array.isArray(o) ? o : null;
        } catch (e) { return null; }
    }

    /** 从 blocks.ial 文本里取出唯一属性并解析。 */
    function fromIal(ial, decode) {
        var m = new RegExp(ATTR + '="([^"]*)"').exec(String(ial || ""));
        return m ? parse(m[1], decode) : null;
    }

    /** 去掉空值，减小属性体积；META_KEYS 即使为空也保留，保证 xref 字段形状稳定。 */
    function compact(o, keep) {
        var out = {};
        var keepMap = {};
        (keep || META_KEYS).forEach(function (k) { keepMap[k] = 1; });
        Object.keys(o || {}).forEach(function (k) {
            if (UNSAFE_KEYS[k]) return;
            var v = o[k];
            if (v == null || v === false || (v === "" && !keepMap[k]) || (v === 0 && !keepMap[k])) return;
            if (k === "owned" || k === "tail") return;   // 冗余字段一律不写
            out[k] = v;
        });
        return out;
    }

    /** 读-改-写用：把 patch 合并进已有 JSON。 */
    function merge(existing, patch) {
        var o = {};
        Object.keys(existing || {}).forEach(function (k) {
            if (!UNSAFE_KEYS[k]) o[k] = existing[k];
        });
        Object.keys(patch || {}).forEach(function (k) {
            if (!UNSAFE_KEYS[k]) o[k] = patch[k];
        });
        return o;
    }

    /** 由 collect 读到的 JSON 生成 buildPlan 需要的 {num,pad,meta,own}。 */
    function toNode(o) {
        if (!o) return null;
        /* 纯正文块 {"bn":…} 不是文档编号信息，不该混进 collect 的 numMap。 */
        var isDoc = DOC_KEYS.some(function (k) {
            return Object.prototype.hasOwnProperty.call(o, k);
        });
        if (!isDoc) return null;
        return {
            num: String(o.num == null ? "" : o.num),
            pad: Number(o.pad) || 0,
            meta: o,
            own: o.head ? {owned: "1", head: String(o.head), tail: ""} : null,
        };
    }

    var api = {
        ATTR: ATTR, META_KEYS: META_KEYS,
        parse: parse, fromIal: fromIal, compact: compact, merge: merge, toNode: toNode,
    };
    /* 只挂 globalThis：本文件拼进 index.js 顶层，module.exports 必须留给插件类。 */
    if (g) g.MSTdnAttrs = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
