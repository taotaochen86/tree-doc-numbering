# -*- coding: utf-8 -*-
"""B 方案补丁步（v1.1.1 + B）：文档树编号也用块属性精确剥离。
由 apply.py 注入 s / core / methods / version 后执行；请勿缩进本文件。
每一处替换都断言锚点命中次数，避免静默漏改。
"""

def bp(old, new, n=1, label=""):
    global s
    c = s.count(old)
    assert c == n, "B-%s 锚点命中 %d 次（期望 %d）: %r" % (label, c, n, old[:70])
    s = s.replace(old, new, n)

# ---------------------------------------------------------------- B1
# stripAny 支持传节点：带 own 标记就精确剥离，完全不跑宽泛正则。
bp(r'''        function stripAny(title) { return stripByFormats(title, stripList); }''',
   r'''        function stripAny(title, node) {
            var P = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
            if (!P) return stripByFormats(title, stripList);
            return P.peel(title, node && node.own,
                          function (t) { return stripByFormats(t, stripList); }).text;
        }''', 1, "stripAny")

bp("            var base = stripAny(node.title);",
   "            var base = stripAny(node.title, node);", 1, "stripBranch")
bp("                var base = stripAny(kid.title).trim();",
   "                var base = stripAny(kid.title, kid).trim();", 1, "walk")

# ---------------------------------------------------------------- B2
# buildPlan 维护 ownMap：由渲染结果 to 与原文 base 算出插件写入的头/尾装饰，
# 统一挂到 out 每一项，供写入链路写块属性。
bp(r'''        var stripList = [activeFormats].concat(o.stripFormats || []).concat(HISTORY_FORMATS);''',
   r'''        var stripList = [activeFormats].concat(o.stripFormats || []).concat(HISTORY_FORMATS);
        var ownMap = {};   // v1.1.2 B：id -> {owned, head, tail}，写入时落块属性''',
   1, "ownMap")

bp(r'''                var to = makeTitle(level, idx, base, activeFormats,
                                   {parentIndex: parentIndex, fn: myChain, parentNum: parentNum});''',
   r'''                var to = makeTitle(level, idx, base, activeFormats,
                                   {parentIndex: parentIndex, fn: myChain, parentNum: parentNum});
                var P = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
                ownMap[kid.id] = P ? P.ownDecor(to, base) : null;''',
   1, "ownDecor")

bp('''        walk(root, 1, null, null, [], "");
        return out;''',
   '''        walk(root, 1, null, null, [], "");
        out.forEach(function (p) { if (!p.own) p.own = ownMap[p.id] || null; });
        return out;''', 1, "out.forEach")

# ---------------------------------------------------------------- B3
# collect：一次 SQL 里顺带解析 own 标记，零额外请求。
# 注意：setBlockAttrs 写的文档属性实测会进 blocks.ial（custom-doc-num 同路径），
# 若个别机器未同步，parseOwn 返回 null → peel 回退保护逻辑，仍然不会误伤。
bp(r'''            const meta = DN.parseIalMeta(ial);
            if (!m && !meta) return;
            numMap.set(r.id, {
                num: m ? m[1] : "",
                pad: pm ? (Number(pm[1]) || 0) : 0,
                meta: meta,
            });''',
   r'''            const meta = DN.parseIalMeta(ial);
            const P = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
            const own = P ? P.parseOwn(ial, DN.decodeIalText) : null;
            if (!m && !meta && !own) return;
            numMap.set(r.id, {
                num: m ? m[1] : "",
                pad: pm ? (Number(pm[1]) || 0) : 0,
                meta: meta,
                own: own,
            });''', 1, "numMap")

bp("                    if (rec) { c.num = rec.num; c.pad = rec.pad; c.meta = rec.meta; }",
   "                    if (rec) { c.num = rec.num; c.pad = rec.pad; c.meta = rec.meta; c.own = rec.own; }",
   1, "node.own")

# 一次 SQL 查 attributes 表读块属性（用户 2026-11-11 提示的提速点）：
#   attributes(block_id, name, value, box) 是结构化字段，value 与 blocks.ial 等价、
#   但不用正则解 HTML 实体；实测 2459 行全表、范围查询 0.002s。
#   替代原先 batchGetBlockAttrs 每 100 个一批的循环（N/100 次请求）。
#   SQL 索引仍可能滞后 0.6~2s；万一刚写完立刻重排没读到标记，
#   MSTreePrefix.isProtected() 仍会放行学号/年份/日期，不会误伤。
#   注意：这里必须重新取一次 TP，forEach 回调里的 P 是块级作用域，此处不可见。
bp("        const orders = {};",
   r'''        const TP = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
        if (TP) {
            try {
                const attrRows = await sql("SELECT block_id, name, value FROM attributes "
                    + "WHERE name IN ('" + TP.ATTR_OWNED + "','" + TP.ATTR_HEAD + "','"
                    + TP.ATTR_TAIL + "') AND box='" + esc(box) + "' LIMIT 20000");
                const byId = new Map();
                (attrRows || []).forEach(function (r) {
                    const rec = byId.get(r.block_id) || {};
                    rec[r.name] = r.value == null ? "" : String(r.value);
                    byId.set(r.block_id, rec);
                });
                byId.forEach(function (a, id) {
                    if (!a[TP.ATTR_OWNED]) return;
                    const rec = numMap.get(id) || {num: "", pad: 0, meta: null};
                    rec.own = {owned: "1",
                               head: a[TP.ATTR_HEAD] || "",
                               tail: a[TP.ATTR_TAIL] || ""};
                    numMap.set(id, rec);
                });
            } catch (e) { /* SQL 失败 → 保留 ial 解析结果 */ }
        }

        const orders = {};''', 1, "attributes 表一次 SQL")

# ---------------------------------------------------------------- B4
# 写入：连同 custom-doc-num 一起，把本轮装饰写进文档块属性。
# own 为 null（排除 / 剥号支）→ 清空标记，避免残留装饰误切用户文本。
bp("    async writeDocNumAttr(id, num, pad, meta) {",
   "    async writeDocNumAttr(id, num, pad, meta, own) {", 1, "writeDocNumAttr 签名")

bp(r'''        const attrs = {
            "custom-doc-num": (num == null || num === "") ? "" : String(num),
            "custom-doc-pad": (pad ? String(pad) : ""),
        };''',
   r'''        const attrs = {
            "custom-doc-num": (num == null || num === "") ? "" : String(num),
            "custom-doc-pad": (pad ? String(pad) : ""),
        };
        const P = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
        if (P) {
            attrs[P.ATTR_OWNED] = own ? "1" : "";
            attrs[P.ATTR_HEAD] = own ? String(own.head || "") : "";
            attrs[P.ATTR_TAIL] = own ? String(own.tail || "") : "";
        }''', 1, "writeDocNumAttr attrs")

bp("                    await this.writeDocNumAttr(p.id, p.num, p.pad, meta);",
   "                    await this.writeDocNumAttr(p.id, p.num, p.pad, meta, p.own);",
   1, "writeDocNumAttr 调用")

# 说明：正文 H 标题已有 v1.1.1 的 D 方案（custom-body-num 精确剥离），本次不动。
# 无标记的历史文档由 tree-prefix.js 的 isProtected() 保护学号 / 年份 / 日期 / 纯数字。

print("B 文档树块属性精确剥离: OK")
