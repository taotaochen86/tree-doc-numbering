# -*- coding: utf-8 -*-
"""融合替换逻辑（由 apply.py 注入 s / core / methods 后执行；请勿缩进本文件）。
    与工作空间 build_fusion.py 的 D/E/F/A/B/C 步逐字一致。"""

# D：修正原版 BN.stripNumber —— 行首年份/日期不得被当成「旧编号」剥掉
#     用户 2026-11-10 11:15 报：「2024年8月9日~11日」编号后变「8月9日~11日」。
#     根因：模板 {n} 派生 ^\d+\s*，RE_NUM 吃 YYYY.MM.DD，二者都会误伤行首 4 位年份。
d1 = "    var STRIP_RES = [RE_DUP_PAIR, RE_DOT_JUNK, RE_DOT_RESIDUE, RE_NUM, RE_PAREN, RE_HALF, RE_CIRCLE];"
assert s.count(d1) == 1, "D1 锚点匹配 %d 次" % s.count(d1)
date_def = r'''

    /* 日期保护（融合层 2026-11-10）：行首 4 位年份 / N月N日 是正文，不是编号。
     * 剥号过程中只要剩下的内容以日期开头，立即停手，保留用户原文。
     * 只认「19xx/20xx 后跟 年 或 -/.+数字」与「N月N日」，不会放过真编号（1.1 / 35.1）。 */
    var RE_DATE_HEAD = /^\s*(?:(?:19|20)\d{2}(?=\s*(?:年|[-/.]\s*\d{1,2}))|\d{1,2}\s*月\s*\d{1,2}\s*日)/;
    function isDateHead(s) { return RE_DATE_HEAD.test(String(s == null ? "" : s)); }
    if (typeof globalThis !== "undefined") globalThis.__msIsDateHead = isDateHead;'''
s = s.replace(d1, d1 + date_def, 1)

old_fn = '''    function stripNumber(body, strips) {
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
    }'''
new_fn = '''    function stripNumber(body, strips) {
        var s = String(body == null ? "" : body);
        var list = strips && strips.length ? strips : STRIP_RES;
        var guard = 0, changed = true;
        while (changed && guard++ < 6) {
            changed = false;
            if (isDateHead(s)) break;
            var tpl = stripTplJunk(s);
            if (tpl !== s) { s = tpl; changed = true; }
            if (isDateHead(s)) break;
            for (var i = 0; i < list.length; i++) {
                if (isDateHead(s)) break;   // 剥完前缀后剩下的是日期 → 停手
                if (list[i].test(s)) {
                    s = s.replace(list[i], "");
                    changed = true;
                }
            }
        }
        return s;
    }'''
assert s.count(old_fn) == 1, "D2 stripNumber 匹配 %d 次" % s.count(old_fn)
s = s.replace(old_fn, new_fn, 1)
print("D 日期保护（BN.stripNumber）: OK")

# E：D 方案 —— 用块属性标记隔离「插件编号」与「用户文本」，写入改批量链路
#     用户 11:42/11:45 口径：getDocBlocksOrders 取顺序 → batchUpdateBlock 批量改
#     → batchSetBlockAttrs 批量写标记，不再逐块 updateBlock。
e1 = """            return {id: b.id, level: eff, markdown: b.markdown,
                    focused: focused, parts: parts};"""
e1n = """            return {id: b.id, level: eff, markdown: b.markdown,
                    focused: focused, parts: parts, preStripped: !!b.preStripped};"""
assert s.count(e1) == 1, "E1 匹配 %d 次" % s.count(e1)
s = s.replace(e1, e1n, 1)

# buildBodyPlan 开头还有一次 blocks.map 重建对象，preStripped 必须在这里也带上，
# 否则 E2 的分支永远为 false（真机首轮验收抓到：3.2 版本说明 → 版本说明）。
e1b = """        var blocks = (o.blocks || []).map(function (b) {
            var lv = Number(b.level) || 0;
            if (focus && String(b.id) === String(focus.id)) lv = Number(focus.level) || lv;
            return {id: b.id, level: lv, markdown: String(b.markdown == null ? "" : b.markdown)};
        });"""
e1bn = """        var blocks = (o.blocks || []).map(function (b) {
            var lv = Number(b.level) || 0;
            if (focus && String(b.id) === String(focus.id)) lv = Number(focus.level) || lv;
            return {id: b.id, level: lv, markdown: String(b.markdown == null ? "" : b.markdown),
                    preStripped: !!b.preStripped};
        });"""
assert s.count(e1b) == 1, "E1b 匹配 %d 次" % s.count(e1b)
s = s.replace(e1b, e1bn, 1)

e2 = "            var body = stripNumber(stripHandNumber(parts.body), strips);"
e2n = ("            /* D 方案：已按块属性精确剥离过编号 → 直接信任用户文本，\n"
       "             * 不再跑任何正则猜测（年份/版本号/金额都不会被误伤）。 */\n"
       "            var body = b.preStripped ? parts.body\n"
       "                                    : stripNumber(stripHandNumber(parts.body), strips);")
assert s.count(e2) == 1, "E2 匹配 %d 次" % s.count(e2)
s = s.replace(e2, e2n, 1)

e3 = '        const blocks = ordered.map((b) => ({id: b.id, level: b.level, markdown: mdMap.get(b.id) || ""}));'
e3n = """        /* D 方案：块属性 custom-body-num 记着插件自己写的编号；命中就精确剥离，
         * 并标记 preStripped 让 buildBodyPlan 跳过正则。无标记（历史文档）回退原逻辑。 */
        const ownNums = await this.msOwnNums(ordered.map((b) => b.id));
        const blocks = ordered.map((b) => {
            const peeled = this.msStrictPeel(mdMap.get(b.id) || "", ownNums[String(b.id)]);
            return {id: b.id, level: b.level, markdown: peeled.markdown,
                    preStripped: peeled.hit};
        });"""
assert s.count(e3) == 2, "E3 匹配 %d 次（应为 2：bodyPlanFor + numberBodyAtCursor）" % s.count(e3)
s = s.replace(e3, e3n)

e4 = "            g.plan.forEach((p) => changes.push({docId: id, id: p.id, from: p.from, to: p.to}));"
e4n = ("            g.plan.forEach((p) => changes.push({docId: id, id: p.id, from: p.from, to: p.to,\n"
       "                                                number: p.number || \"\"}));")
assert s.count(e4) == 1, "E4 匹配 %d 次" % s.count(e4)
s = s.replace(e4, e4n, 1)

writes = [
    ("""        const failed = [];
        let changed = 0;
        for (const c of changes) {
            try {
                await api("/api/block/updateBlock", {id: c.id, dataType: "markdown", data: c.to});
                changed++;
            } catch (e) {
                failed.push({docId: c.docId, id: c.id, error: e.message});
                break;   // 中断即停，避免半套编号；已写的条目都记在快照里
            }
        }""",
     """        const wr = await this.msBatchWrite(changes);
        const failed = wr.failed;
        const changed = wr.changed;"""),
    ("""        const failed = [];
        let changed = 0;
        for (const p of g.plan) {
            try {
                await api("/api/block/updateBlock", {id: p.id, dataType: "markdown", data: p.to});
                changed++;
            } catch (e) {
                failed.push({id: p.id, error: e.message});
                break;   // 不继续写后面的，避免半套编号
            }
        }""",
     """        const wr = await this.msBatchWrite(g.plan.map((p) => ({id: p.id, to: p.to,
            number: p.number, docId: docId})));
        const failed = wr.failed;
        const changed = wr.changed;"""),
    ("""        const failed = [];
        let changed = 0;
        for (const p of r.plan) {
            try {
                await api("/api/block/updateBlock", {id: p.id, dataType: "markdown", data: p.to});
                changed++;
            } catch (e) {
                failed.push({id: p.id, error: e.message});
                break;
            }
        }""",
     """        const wr = await this.msBatchWrite(r.plan.map((p) => ({id: p.id, to: p.to,
            number: p.number, docId: docId})));
        const failed = wr.failed;
        const changed = wr.changed;"""),
]
for i, (old, new) in enumerate(writes, 1):
    assert s.count(old) == 1, "E5.%d 匹配 %d 次" % (i, s.count(old))
    s = s.replace(old, new, 1)
print("E 隔离标记 + 批量写入（3 条路径）: OK")

# F：范围隔离（用户 11:53）
#   (1) 文档树编号事件不再触发任何文档内部标题编号；
#   (2) 文档内部编号事件只作用于当前文档，不展开子树、不碰其它文档。
f1 = """        let body = null;
        if (cfg.bodyEnabled !== false) {
            try {
                const ids = await this.rangeDocIds();
                if (ids.length) body = await this.numberBodyRange(ids, {source: "runAll", silent: true});
            } catch (e) { body = {ok: false, error: e.message}; }
        }"""
f1n = """        let body = null;
        /* 范围隔离：树编号事件（autoCheck / 立即重排）绝不连带改正文标题。
         * 正文编号只在「文档 + 内容」等显式入口、或拆合补激发时按指定 ID 触发。 */
        if (cfg.bodyEnabled !== false && o.includeBody === true) {
            try {
                const ids = await this.rangeDocIds();
                if (ids.length) body = await this.numberBodyRange(ids, {source: "runAll", silent: true});
            } catch (e) { body = {ok: false, error: e.message}; }
        }"""
assert s.count(f1) == 1, "F1 匹配 %d 次" % s.count(f1)
s = s.replace(f1, f1n, 1)

f2 = """        const ids = await this.idsForTarget({type: target.type || "doc", id: target.id, box: target.box});
        if (!ids.length) return {ok: false, reason: "no-docs"};"""
f2n = """        // 范围隔离：内容标题编号只作用于当前文档，不展开子树、不碰其它文档
        const ids = [String(target.id)].filter((x) => ID_RE.test(x));
        if (!ids.length) return {ok: false, reason: "no-docs"};"""
assert s.count(f2) == 1, "F2 匹配 %d 次" % s.count(f2)
s = s.replace(f2, f2n, 1)

f3 = """            let ids = await this.idsForTarget({type: target.type || "doc", id: target.id, box: target.box});
            const ex = (this._config && this._config.excluded) || [];"""
f3n = """            // 范围隔离：「文档 + 内容」也只给当前文档编正文
            let ids = [String(target.id)].filter((x) => ID_RE.test(x));
            const ex = (this._config && this._config.excluded) || [];"""
assert s.count(f3) == 1, "F3 匹配 %d 次" % s.count(f3)
s = s.replace(f3, f3n, 1)
print("F 范围隔离（树编号不碰正文 / 正文只作用当前文档）: OK")

# A：class 之前插入纯函数层
a = "module.exports = class DocNumberPlugin extends Plugin {"
assert s.count(a) == 1, "A 锚点匹配 %d 次" % s.count(a)
s = s.replace(a, core.rstrip() + "\n\n" + a, 1)
print("A 纯函数层: OK")

# B：原右键方法改名，由融合层的 onDocTreeMenu 包装成两个二级菜单
b = "    onDocTreeMenu(event) {"
assert s.count(b) == 1, "B 锚点匹配 %d 次" % s.count(b)
s = s.replace(b, "    onDocTreeMenuInner(event) {", 1)
print("B 菜单改名 + 二级包装: OK")

# C：class 末尾插入方法
c = "\n};\n"
pos = s.rstrip().rfind("};")
assert pos > 0, "C 找不到类结束"
s = s[:pos] + methods.rstrip() + "\n" + s[pos:]
print("C 插件方法: OK")
