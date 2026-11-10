/* ===== 融合层 A：文档合并与拆分 · 纯函数（插入到 class 定义之前） =====
   2026-11-10 新规格：
   · 按「内容最高层次标题」拆；该级标题变成文档名，不在新文档正文显示。
   · 新文档正文其余标题整体「提升一级」（h 数 -1）；合并时「降一级」（h 数 +1），互逆自洽。
   · 拆分后清空原文档，但一级标题前的文本（前言）保留在原文档。
   · 「拆分为多子文档」始终保留原文档（作容器）；「拆分为多个平行文档」仅当清空后
     原文档内容为空（没有前言）时才删除原文档（用户 10:17 补充）。
   · 合并时各文档名作「一级标题」，正文标题降一级，追加到父文档末尾。
   · 所有进入拆/合的文本先由类方法 msStripMd / msStripName 剔除编号与排版格式。 */
const MSCORE = (function () {
    "use strict";
    const ID_RE = /^\d{14}-[a-z0-9]{7}$/i;
    // 单点口径：Q1 相对层级 / Q2 必须升降一级 / Q4 同名加序号
    const CFG = {KEEP_MERGE_TARGET: false, MAX_UNDO: 10,
                 DEFAULT_MERGE_LEVEL: 1, MERGE_DOC_NAME: "合并文档",
                 PROMOTE_ON_SPLIT: true, DELETE_EMPTY_SIBLING_SOURCE: true};

    function trimBlankLines(s) {
        const lines = String(s || "").split(/\r?\n/);
        let a = 0, b = lines.length;
        while (a < b && /^[ \t]*$/.test(lines[a])) a++;
        while (b > a && /^[ \t]*$/.test(lines[b - 1])) b--;
        return lines.slice(a, b).join("\n");
    }
    function stripFrontMatter(md) {
        const s = String(md || "").replace(/^\uFEFF/, "");
        const lines = s.split(/\r?\n/);
        if (lines.length && lines[0].trim() === "---") {
            for (let i = 1; i < lines.length; i++) {
                const t = lines[i].trim();
                if (t === "---" || t === "...") return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
            }
        }
        return s;
    }
    function scanHeadings(md) {
        const lines = String(md || "").split(/\r?\n/);
        const out = []; let fence = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            if (fm) {
                const ch = fm[1].charAt(0), len = fm[1].length;
                if (!fence) fence = {ch, len};
                else if (fence.ch === ch && len >= fence.len) fence = null;
                continue;
            }
            if (fence) continue;
            const hm = line.match(/^(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
            if (hm) out.push({index: i, level: hm[1].length, text: hm[2].trim()});
        }
        return out;
    }
    function detectTopLevel(md) {
        const hs = scanHeadings(stripFrontMatter(md));
        if (!hs.length) return null;
        let min = 7;
        hs.forEach(h => { if (h.level < min) min = h.level; });
        return min;
    }
    /** 标题整体升降级；代码块围栏内的 # 不动。 */
    function shiftHeadings(md, delta) {
        const lines = String(md || "").split(/\r?\n/);
        let fence = null;
        return lines.map(line => {
            const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            if (fm) {
                const ch = fm[1].charAt(0), len = fm[1].length;
                if (!fence) fence = {ch, len};
                else if (fence.ch === ch && len >= fence.len) fence = null;
                return line;
            }
            if (fence) return line;
            const hm = line.match(/^(#{1,6})([ \t]+)(.*)$/);
            if (!hm) return line;
            const lv = Math.min(6, Math.max(1, hm[1].length + delta));
            return "#".repeat(lv) + hm[2] + hm[3];
        }).join("\n");
    }
    const promoteBody = body => CFG.PROMOTE_ON_SPLIT ? shiftHeadings(String(body || ""), -1) : String(body || "");
    const demoteBody = body => CFG.PROMOTE_ON_SPLIT ? shiftHeadings(String(body || ""), +1) : String(body || "");

    /** 按最高层级切分：sections[].body 不含该级标题行；preamble 单独留原文档。 */
    function splitByLevel(md, level) {
        const clean = stripFrontMatter(md);
        const lines = clean.split(/\r?\n/);
        const lv = Math.min(6, Math.max(1, Number(level) || 1));
        const hs = scanHeadings(clean).filter(h => h.level === lv);
        const preamble = hs.length
            ? trimBlankLines(lines.slice(0, hs[0].index).join("\n"))
            : trimBlankLines(clean);
        const sections = [];
        for (let i = 0; i < hs.length; i++) {
            const start = hs[i].index + 1;
            const end = (i + 1 < hs.length) ? hs[i + 1].index : lines.length;
            sections.push({title: hs[i].text, body: trimBlankLines(lines.slice(start, end).join("\n"))});
        }
        return {level: lv, preamble, sections};
    }
    /** 合并段：文档名作 level 级标题 + 降一级后的正文。 */
    function mergeSegment(title, body, level) {
        const lv = Math.min(6, Math.max(1, Number(level) || CFG.DEFAULT_MERGE_LEVEL));
        return "#".repeat(lv) + " " + String(title || "").trim() + "\n\n" + trimBlankLines(demoteBody(body));
    }
    /** 由子文档正文推断「一级标题」层级：拆分时提升过一级，故正文最高层级即原最高层级。 */
    function inferLevel(mds) {
        let min = 7;
        (mds || []).forEach(md => {
            const l = detectTopLevel(md);
            if (l && l < min) min = l;
        });
        return min <= 6 ? min : CFG.DEFAULT_MERGE_LEVEL;
    }
    function normalizeForCompare(md) {
        return String(md || "").split(/\r?\n/)
            .map(l => l.replace(/\s+$/, "")).filter(l => l.trim() !== "").join("\n").trim();
    }
    function sanitizeTitle(t) {
        return String(t || "").replace(/[\r\n\t]+/g, " ").replace(/[\/\\]/g, "／").trim() || "未命名";
    }
    function hpathChild(hpath, title) {
        return String(hpath || "").replace(/\/+$/, "") + "/" + sanitizeTitle(title);
    }
    function hpathSibling(hpath, title) {
        const p = String(hpath || "").replace(/\/+$/, "");
        const i = p.lastIndexOf("/");
        return (i > 0 ? p.slice(0, i) : "") + "/" + sanitizeTitle(title);
    }
    function flattenTree(node) {
        const out = [];
        (function walk(n) { ((n && n.children) || []).forEach(c => { out.push(c.id); walk(c); }); })(node);
        return out;
    }
    function topLevelIds(node) { return ((node && node.children) || []).map(c => c.id); }
    function readTargets(detail) {
        const els = (detail && detail.elements) || [];
        const out = [], seen = {};
        for (const el of els) {
            const node = (el && el.closest) ? el.closest("li[data-type]") : el;
            if (!node || !node.getAttribute) continue;
            if (String(node.getAttribute("data-type") || "").toLowerCase() !== "navigation-file") continue;
            const id = String(node.getAttribute("data-node-id") || "");
            if (!ID_RE.test(id) || seen[id]) continue;
            seen[id] = 1;
            out.push({id, box: String(node.getAttribute("data-box") || ""),
                      name: String(node.getAttribute("data-name") || "")});
        }
        return out;
    }
    function menuPlan(count) {
        if (count > 1) return [{op: "merge-many", label: "合并为一个文档", icon: "iconCopy"}];
        if (count !== 1) return [];
        return [
            {op: "split-sub", label: "拆分为多子文档", icon: "iconAdd"},
            {op: "split-sibling", label: "拆分为多个平行文档", icon: "iconFiles"},
            {op: "merge-children", label: "合并子文档到本文档", icon: "iconRefresh"},
        ];
    }
    function planDeletes(op, targetId, topIds, sourceIds) {
        if (op === "merge-many") return (sourceIds || []).filter(id =>
            !(CFG.KEEP_MERGE_TARGET && id === targetId));
        if (op === "merge-children") return (topIds || []).slice();
        return [];   // 拆分是否删原文档由 msSplit 按「平行 + 空内容」条件决定
    }
    return {ID_RE, CFG, trimBlankLines, stripFrontMatter, scanHeadings, detectTopLevel,
            shiftHeadings, promoteBody, demoteBody, splitByLevel, mergeSegment, inferLevel,
            normalizeForCompare, sanitizeTitle, hpathChild, hpathSibling,
            flattenTree, topLevelIds, readTargets, menuPlan, planDeletes};
})();
