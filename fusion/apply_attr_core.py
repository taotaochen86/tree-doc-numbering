# -*- coding: utf-8 -*-
"""v1.2.0 单属性补丁步：插件所有状态收进唯一属性 custom-doc-num-meta 的一个 JSON。
由 apply.py 在 apply_core / apply_b_core 之后执行，注入 s（当前融合文本）。
每处替换都断言锚点命中次数，避免静默漏改。请勿缩进本文件。
"""
def bp(old, new, n=1, label=""):
    global s
    c = s.count(old)
    assert c == n, "ATTR-%s 锚点命中 %d 次（期望 %d）: %r" % (label, c, n, old[:80])
    s = s.replace(old, new, n)

# ---------------------------------------------------------------- A1
# collect：文档块属性从「多个独立属性」改成「一个 JSON」；ial 解析只作兜底。
bp(r'''        (numRows || []).forEach((r) => {
            const ial = String(r.ial || "");
            const m = /custom-doc-num="([^"]*)"/.exec(ial);
            const pm = /custom-doc-pad="([^"]*)"/.exec(ial);
            /* v0.8.9：同一次 ial 里顺带把 JSON 元数据解析出来，零额外请求。 */
            const meta = DN.parseIalMeta(ial);
            const P = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
            const own = P ? P.parseOwn(ial, DN.decodeIalText) : null;
            if (!m && !meta && !own) return;
            numMap.set(r.id, {
                num: m ? m[1] : "",
                pad: pm ? (Number(pm[1]) || 0) : 0,
                meta: meta,
                own: own,
            });
        });''',
   r'''        /* v1.2.0：所有状态都在唯一属性 custom-doc-num-meta 的一个 JSON 里。
         * 这里只作兜底；下面一次 SQL 查 attributes 表（结构化、无需解 HTML 实体）会覆盖。
         * 兼容：未迁移的设备仍能从旧属性读出 head，避免升级后误剥学号（只读，绝不写回）。 */
        (numRows || []).forEach((r) => {
            const A0 = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
            const P0 = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
            const ial = String(r.ial || "");
            let node = A0 ? A0.toNode(A0.fromIal(ial, DN.decodeIalText)) : null;
            if (!node) {
                const legacy = P0 ? P0.parseOwn(ial, DN.decodeIalText) : null;
                const m = /custom-doc-num="([^"]*)"/.exec(ial);
                const pm = /custom-doc-pad="([^"]*)"/.exec(ial);
                if (legacy || m) node = {
                    num: m ? m[1] : "",
                    pad: pm ? (Number(pm[1]) || 0) : 0,
                    meta: DN.parseIalMeta(ial),
                    own: legacy ? {owned: "1", head: legacy.head || "", tail: legacy.tail || ""} : null,
                };
            }
            if (node) numMap.set(r.id, node);
        });''', 1, "collect ial")

bp(r'''        const TP = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
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
        }''',
   r'''        /* v1.2.0：一次 SQL 读回全部文档状态（原来要查 3 个属性 + 解 ial）。 */
        const TA = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
        if (TA) {
            try {
                const attrRows = await sql("SELECT block_id, value FROM attributes "
                    + "WHERE name='" + TA.ATTR + "' AND box='" + esc(box) + "' LIMIT 20000");
                (attrRows || []).forEach(function (r) {
                    const node = TA.toNode(TA.parse(r.value));
                    if (node) numMap.set(r.block_id, node);
                });
            } catch (e) { /* SQL 失败 → 保留 ial 兜底结果 */ }
        }''', 1, "collect attributes SQL")

# ---------------------------------------------------------------- A2
# syncScopeMeta：批量写之前先批量读，把 rootID/rootNum/targetId 合并进已有 JSON，
# 绝不覆盖 num / pad / head（否则会把树编号状态抹掉）。
bp(r'''                    const attrs = {};
                    attrs[DN.META_ATTR] = DN.docNumMeta(rootID, node.chain, t.id);
                    items.push({id: id, attrs: attrs});''',
   r'''                    const attrs = {};
                    attrs[DN.META_ATTR] = DN.docNumMeta(rootID, node.chain, t.id);
                    items.push({id: id, attrs: attrs, metaPatch: attrs[DN.META_ATTR]});''',
   1, "syncScopeMeta items")

bp(r'''        let written = 0;
        for (let i = 0; i < items.length; i += 100) {
            const chunk = items.slice(i, i + 100);
            await api("/api/attr/batchSetBlockAttrs", {blockAttrs: chunk});
            written += chunk.length;
        }
        return Object.assign(preview, {written: written});''',
   r'''        let written = 0;
        const A2 = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
        for (let i = 0; i < items.length; i += 100) {
            const chunk = items.slice(i, i + 100);
            let cur = {};
            try {
                cur = await api("/api/attr/batchGetBlockAttrs",
                                {ids: chunk.map(x => x.id)}) || {};
            } catch (e) { /* 读不到就只写 meta 三字段 */ }
            const merged = chunk.map(function (x) {
                const raw = cur && cur[x.id] ? cur[x.id][A2 ? A2.ATTR : DN.META_ATTR] : "";
                const o = A2 ? A2.parse(raw) : null;
                let patch = {};
                try { patch = JSON.parse(x.metaPatch) || {}; } catch (e) {}
                const out = {};
                const attrs = {};
                const all = A2 ? A2.merge(o, patch) : Object.assign({}, o || {}, patch);
                attrs[DN.META_ATTR] = JSON.stringify(A2 ? A2.compact(all) : all);
                return {id: x.id, attrs: attrs};
            });
            await api("/api/attr/batchSetBlockAttrs", {blockAttrs: merged});
            written += merged.length;
        }
        return Object.assign(preview, {written: written});''', 1, "syncScopeMeta merge")

# ---------------------------------------------------------------- A3
# 文档块写入：只写唯一属性，值是一个 JSON 字符串。
bp(r'''    /** 把编号写进文档属性 custom-doc-num（v0.8.0）。
     *  这是「模板怎么变都无所谓」的关键：号存在文档上，正文编号只读属性，不再猜标题长相。
     *  num 为空 → 清掉属性（文档被排除 / 不再编号时）。 */
    async writeDocNumAttr(id, num, pad, meta, own) {
        if (!id || !ID_RE.test(String(id))) return false;
        const attrs = {
            "custom-doc-num": (num == null || num === "") ? "" : String(num),
            "custom-doc-pad": (pad ? String(pad) : ""),
        };
        const P = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
        if (P) {
            attrs[P.ATTR_OWNED] = own ? "1" : "";
            attrs[P.ATTR_HEAD] = own ? String(own.head || "") : "";
            attrs[P.ATTR_TAIL] = own ? String(own.tail || "") : "";
        }
        /* v0.8.9：meta 是 custom-doc-num-meta 的 JSON 字符串，和上面两个属性一次写掉。 */
        if (meta != null) attrs[DN.META_ATTR] = String(meta);
        try {
            await api("/api/attr/setBlockAttrs", {id: id, attrs: attrs});
            return true;
        } catch (e) { return false; }
    }''',
   r'''    /** v1.2.0：文档状态只写唯一属性 custom-doc-num-meta，值是一个 JSON 字符串。
     *  num / pad / head 与 meta 三字段（rootID / rootNum / targetId）一起写入；
     *  owned（恒 1）与 tail（从未用）已剔除。 */
    async writeDocNumAttr(id, num, pad, meta, own) {
        if (!id || !ID_RE.test(String(id))) return false;
        const A3 = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
        let o = {};
        if (meta != null) { try { o = JSON.parse(String(meta)) || {}; } catch (e) {} }
        o.num = (num == null || num === "") ? "" : String(num);
        o.pad = pad ? Number(pad) : 0;
        if (own && own.head) o.head = String(own.head); else delete o.head;
        const attrs = {};
        attrs[A3 ? A3.ATTR : DN.META_ATTR] = JSON.stringify(A3 ? A3.compact(o) : o);
        try {
            await api("/api/attr/setBlockAttrs", {id: id, attrs: attrs});
            return true;
        } catch (e) { return false; }
    }''', 1, "writeDocNumAttr")

# ---------------------------------------------------------------- A4
# 文档块读取：实时接口 / SQL ial 两路都从唯一 JSON 取 num / pad。
bp(r'''    /** 读文档属性里的编号。实时接口优先，失败退回 SQL（ial 字段）。 */
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
    }''',
   r'''    /** v1.2.0：读唯一 JSON 属性里的 num / pad。实时接口优先，失败退回 SQL（ial 字段）。 */
    async readDocNumAttr(id) {
        const empty = {num: "", pad: 0};
        if (!id || !ID_RE.test(String(id))) return empty;
        const A4 = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
        const pick = function (o) {
            if (!o) return empty;
            return {num: String(o.num == null ? "" : o.num).trim(), pad: Number(o.pad) || 0};
        };
        try {
            const d = await api("/api/attr/getBlockAttrs", {id: id});
            const attrs = (d && d.attrs) || d || {};
            return pick(A4 ? A4.parse(attrs[A4.ATTR]) : null);
        } catch (e) { /* 落到 SQL */ }
        try {
            const rows = await sql("SELECT ial FROM blocks WHERE id='" + esc(id) + "' LIMIT 1");
            const ial = rows && rows[0] ? String(rows[0].ial || "") : "";
            return pick(A4 ? A4.fromIal(ial, DN.decodeIalText) : null);
        } catch (e) { return empty; }
    }''', 1, "readDocNumAttr")

# ---------------------------------------------------------------- A5
# 正文标题块：D 方案的 custom-body-num 也收进唯一属性的 bn 字段。
bp(r'''    /** 批量读标记：一次 SQL 拿全，避免逐块请求。 */
    async msOwnNums(ids) {
        const out = {};
        const list = (ids || []).filter(Boolean).map(String);
        if (!list.length) return out;
        // 实测：setBlockAttrs/batchSetBlockAttrs 写的自定义属性不进 blocks.ial，
        // 必须用 batchGetBlockAttrs({ids}) 读，SQL 查 ial 会一个都读不到。
        for (let i = 0; i < list.length; i += 100) {
            try {
                const d = await this.msApi("/api/attr/batchGetBlockAttrs",
                                           {ids: list.slice(i, i + 100)});
                Object.keys(d || {}).forEach(k => {
                    const a = d[k] || {};
                    if (a["custom-body-num"]) out[k] = String(a["custom-body-num"]);
                });
            } catch (e) {}
        }
        return out;
    }''',
   r'''    /** v1.2.0：批量读唯一 JSON 属性里的 bn（正文标题编号）。 */
    async msOwnNums(ids) {
        const out = {};
        const list = (ids || []).filter(Boolean).map(String);
        if (!list.length) return out;
        const A5 = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
        // 实测：setBlockAttrs/batchSetBlockAttrs 写的自定义属性不进 blocks.ial，
        // 必须用 batchGetBlockAttrs({ids}) 读，SQL 查 ial 会一个都读不到。
        for (let i = 0; i < list.length; i += 100) {
            try {
                const d = await this.msApi("/api/attr/batchGetBlockAttrs",
                                           {ids: list.slice(i, i + 100)});
                Object.keys(d || {}).forEach(k => {
                    const a = d[k] || {};
                    const o = A5 ? A5.parse(a[A5.ATTR]) : null;
                    if (o && o.bn) out[k] = String(o.bn);
                });
            } catch (e) {}
        }
        return out;
    }''', 1, "msOwnNums")

bp(r'''            const chunk = list.slice(i, i + 100).map(x => ({
                id: x.id, attrs: {"custom-body-num": String(x.num)},
            }));''',
   r'''            const A6 = (typeof globalThis !== "undefined" && globalThis.MSTdnAttrs) || null;
            const chunk = list.slice(i, i + 100).map(x => {
                const attrs = {};
                attrs[A6 ? A6.ATTR : "custom-doc-num-meta"] = JSON.stringify({bn: String(x.num)});
                return {id: x.id, attrs: attrs};
            });''', 1, "msSetOwnNums")

print("ATTR 单属性合并（v1.2.0）: OK")
