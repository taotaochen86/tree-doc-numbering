
    /* ===== 融合层 C：文档合并与拆分 · 插件方法（插入到 class 末尾） =====
       2026-11-10 新规格实现；导出统一经 msStripMd / msStripName 剔除编号与排版格式。 */

    /** 右键菜单分二级：树文编号管理（原编号功能）/ 树文拆合管理（4 个新功能）。
     *  用代理 menu 收集原方法挂的项，不改 onDocTreeMenuInner 一行代码。 */
    onDocTreeMenu(event) {
        const d = event && event.detail;
        if (!d || !d.menu || !d.elements || !d.elements.length) return;
        const num = [], sp = [], real = d.menu;
        const collect = arr => ({
            addItem: o => arr.push(o),
            addSeparator: () => arr.push({type: "separator"}),
        });
        d.menu = collect(num);
        try { this.onDocTreeMenuInner(event); }
        catch (e) { console.error("[doc-num] 菜单构建失败", e); }
        finally { d.menu = real; }
        d.menu = collect(sp);
        try { this.msAddMenuItems(d); }
        catch (e) { console.error("[merge-split] 菜单构建失败", e); }
        finally { d.menu = real; }
        if (num.length) real.addItem({icon: MENU_ICON, label: "树文编号管理", submenu: num});
        if (sp.length) real.addItem({icon: "iconFiles", label: "树文拆合管理", submenu: sp});
    }

    msAddMenuItems(detail) {
        const targets = MSCORE.readTargets(detail);
        if (!targets.length) return;
        const frozen = JSON.parse(JSON.stringify(targets));
        const plan = MSCORE.menuPlan(frozen.length);
        const self = this;
        plan.forEach(item => {
            const op = item.op;
            detail.menu.addItem({
                icon: item.icon, label: item.label,
                click: () => self.msWithLock(() => self.msRun(op, frozen)).catch(e => {
                    console.error("[merge-split]", e);
                    msg("合并/拆分失败：" + (e && e.message || e), 9000, "error");
                }),
            });
        });
    }

    msWithLock(fn) {
        if (!this._msLock) this._msLock = Promise.resolve();
        const prev = this._msLock;
        let release;
        this._msLock = new Promise(r => { release = r; });
        return prev.then(fn).then(v => { release(); return v; }, e => { release(); throw e; });
    }

    async msApi(path, payload) {
        const r = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json"},
                                    body: JSON.stringify(payload || {})});
        const j = await r.json();
        if (j.code !== 0) throw new Error(path + "：" + (j.msg || "code " + j.code));
        return j.data;
    }
    msSql(stmt) { return this.msApi("/api/query/sql", {stmt}); }
    async msDocMeta(ids) {
        const list = (ids || []).filter(i => MSCORE.ID_RE.test(i));
        if (!list.length) return [];
        const inList = list.map(i => "'" + String(i).replace(/'/g, "''") + "'").join(",");
        return this.msSql("SELECT id, box, path, hpath, content FROM blocks WHERE type='d' AND id IN (" +
                          inList + ") LIMIT 1000");
    }
    async msExport(id) {
        const d = await this.msApi("/api/export/exportMdContent", {id});
        return (d && d.content) || "";
    }

    /* ===== D 方案：编号文本 / 用户文本隔离 =====
       编号写入时给标题块打 custom-body-num 属性（记录纯编号），属性不进 markdown / 导出。
       剥号时先按属性精确移除，命中就完全不跑正则 —— 用户文本里的年份、版本号、金额
       再也不会被误当旧编号。无属性的历史文档回退原正则（含日期保护），编号一次后自动纳入。 */

    /** 批量读标记：一次 SQL 拿全，避免逐块请求。 */
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
    }
    /** 一次批量写标记：updateBlock 会清掉块属性，必须在写完内容之后调用。 */
    async msSetOwnNums(items) {
        const list = (items || []).filter(x => x && x.id && x.num);
        if (!list.length) return 0;
        let n = 0;
        for (let i = 0; i < list.length; i += 100) {
            const chunk = list.slice(i, i + 100).map(x => ({
                id: x.id, attrs: {"custom-body-num": String(x.num)},
            }));
            try {
                await this.msApi("/api/attr/batchSetBlockAttrs", {blockAttrs: chunk});
                n += chunk.length;
            } catch (e) { console.warn("[doc-num] 批量写编号标记失败", e); }
        }
        return n;
    }
    /** 批量写入主链（用户 11:45 口径）：取顺序 → 批量改标题 → 批量写标记。
     *  items: [{id, to, number, docId}]。批量接口不可用/失败时回退逐块 updateBlock。 */
    async msBatchWrite(items) {
        const list = (items || []).filter(x => x && x.id && x.to != null);
        if (!list.length) return {changed: 0, failed: []};
        // 1. 按文档取块顺序，保证编号计算顺序与文档一致（SQL 索引有延迟时尤其重要）
        const byDoc = {};
        list.forEach(x => { const k = x.docId || ""; (byDoc[k] = byDoc[k] || []).push(x); });
        const ordered = [];
        for (const docId of Object.keys(byDoc)) {
            let rank = null;
            try {
                const ids = await this.msApi("/api/block/getDocBlocksOrders", {id: docId});
                if (Array.isArray(ids)) rank = new Map(ids.map((v, i) => [String(v), i]));
            } catch (e) {}
            byDoc[docId].forEach(x => ordered.push({
                x, i: rank && rank.has(String(x.id)) ? rank.get(String(x.id)) : 1e9,
            }));
        }
        ordered.sort((a, b) => a.i - b.i);
        const sorted = ordered.map(o => o.x);
        // 2. 一次批量改内容
        let batchOk = false;
        try {
            await this.msApi("/api/block/batchUpdateBlock", {
                blocks: sorted.map(x => ({id: x.id, dataType: "markdown", data: x.to})),
            });
            batchOk = true;
        } catch (e) { console.warn("[doc-num] batchUpdateBlock 失败，回退逐块", e); }
        if (!batchOk) {
            const failed = [];
            let changed = 0;
            for (const x of sorted) {
                try {
                    await this.msApi("/api/block/updateBlock",
                        {id: x.id, dataType: "markdown", data: x.to});
                    changed++;
                } catch (e) {
                    failed.push({docId: x.docId, id: x.id, error: String(e && e.message || e)});
                    break;
                }
            }
            if (failed.length) return {changed, failed};
        }
        // 3. 一次批量写标记（必须晚于改内容：updateBlock 会清掉块属性）
        const marks = sorted.filter(x => x.number).map(x => ({id: x.id, num: x.number}));
        await this.msSetOwnNums(marks);
        try {
            await this.saveData("ms-last-write.json", JSON.stringify({
                at: new Date().toISOString(),
                mode: batchOk ? "batch" : "fallback",
                blocks: sorted.length, docs: Object.keys(byDoc).length,
                marks: marks.length,
                apiCalls: Object.keys(byDoc).length + (batchOk ? 1 : sorted.length) +
                          Math.ceil(marks.length / 100),
                oldApiCalls: sorted.length + marks.length,
            }, null, 2));
        } catch (e) {}
        return {changed: sorted.length, failed: []};
    }

    /** 当前模板派生的剥号正则（不含 STRIP_RES 宽泛兜底）。
     *  只用这几条，才能既兼容历史已编号文档，又不误伤版本号/年份/金额。 */
    msStrictRes() {
        const cfg = this._config || {};
        let fmt;
        try { fmt = BN.normalizeBodyFormats(cfg.bodyFormats || BN.BUILTIN_BODY_FORMATS); }
        catch (e) { return []; }
        const out = [
            // 文档名模板编号（第N章 / 第N节 / 【N】）：拆合口径要求剔除，
            // 且它带明确汉字/括号标识，不会误伤版本号、年份、金额、时间。
            /^第\s*\d+(?:\.\d+)*\s*[篇部章节]\s*/,
            /^【\s*\d+\s*】\s*/,
        ];
        for (let lv = 1; lv <= BN.LEVEL_MAX; lv++) {
            try {
                const r = BN.bodyStripRegex(fmt[lv]);
                // 只保留「中文数字 / 圈码 / 括号中文数字」这类明确的编号形态。
                // 模板 {n} / {n}. 会派生 ^\d+\s*、^\d+\.\s*，它们会吃掉版本号、
                // 年份、金额、时间、百分数 —— 正是用户要防的误伤，一律排除。
                if (r && !/\\d/.test(r.source)) out.push(r);
            } catch (e) {}
        }
        return out;
    }
    /** 精确剥离，且一律标记 hit=true 让 buildBodyPlan 跳过它自己的正则猜测。
     *  ① 有块属性标记：只移除记录中的那段编号（防用户手改后误剥）；
     *  ② 无标记（历史文档）：只剥当前模板派生的编号形态；
     *  ③ 都不匹配：原样返回 —— 用户文本里的数字一个都不动。 */
    msStrictPeel(markdown, num) {
        const md = String(markdown || "");
        const m = /^(\s*#{1,6}[ \t]+)([\s\S]*)$/.exec(md);
        if (!m) return {markdown: md, hit: false};
        let body = m[2];
        if (num && body.indexOf(num) === 0) {
            return {markdown: m[1] + body.slice(num.length), hit: true};
        }
        for (const r of this.msStrictRes()) {
            if (r.test(body)) { body = body.replace(r, ""); break; }
        }
        return {markdown: m[1] + body, hit: true};
    }

    /** 剔除标题编号 + 行首全角缩进/零宽字符（appendBlock 写出后会加，反复操作会累积）。 */
    msStripMd(md, knownNums) {
        const s = MSCORE.stripFrontMatter(md);
        const nums = knownNums || [];
        return s.split(/\r?\n/).map(line => {
            const l = line.replace(/^[\u3000\u200b\u200c\u200d\ufeff]+/, "");
            if (!/^#{1,6}[ \t]/.test(l)) return l;
            // 只做精确/严格剥离，不再跑宽泛正则，也不再对标题正文跑文档名剥号
            const num = nums.find(n => n && l.replace(/^#{1,6}[ \t]+/, "").indexOf(n) === 0) || "";
            return this.msStrictPeel(l, num).markdown;
        }).join("\n");
    }
    msStripName(name) {
        const cfg = this._config || {};
        const list = [];
        const push = f => { if (f) { try { list.push(DN.normalizeFormats(f, DN.BUILTIN_V4_FORMATS)); } catch (e) {} } };
        push(cfg.defaultFormats); push(cfg.lastDefaultFormats);
        (cfg.targets || []).forEach(t => { push(t.formats); push(t.lastFormats); });
        (cfg.defaultFormatsHistory || []).forEach(push);
        push(DN.BUILTIN_V4_FORMATS);
        let out = String(name || "");
        // 日期/年份开头的文档名是正文，不是编号：DN 的复合号模板会把 YYYY.MM.DD 整体吃掉，
        // 先短路返回。BN.stripNumber 内部已有同一份日期保护（见 build_fusion.py 的 D 步）。
        const isDate = (typeof globalThis !== "undefined" && globalThis.__msIsDateHead) || null;
        if (isDate && isDate(out)) return out;
        // v1.1.2 B 方案：学号 / 年份 / 日期 / 纯数字开头的文档名也是正文，不参与剥号。
        const TP = (typeof globalThis !== "undefined" && globalThis.MSTreePrefix) || null;
        if (TP && TP.isProtected(out)) return out;
        const before = out;
        try { out = DN.stripByFormats(out, list); } catch (e) {}
        try { out = BN.stripNumber(out, BN.bodyStripRegexes(bodyStripList(cfg))); } catch (e) {}
        // 剥成空串（「第4篇」）→ 回退原文，否则这类文档永远不参与编号。
        return String(out).trim() ? out : before;
    }
    /** 导出 = front matter + 自动插入的「# 文档标题」+ 正文，按文档名核对后剥掉那一行。 */
    async msStripMdSafe(id, docTitle) {
        let raw = "";
        for (let i = 0; i < 10; i++) {
            raw = await this.msExport(id);
            if (String(raw).trim()) break;
            await new Promise(r => setTimeout(r, 200));
        }
        const hadFm = /^\uFEFF?---\r?\n/.test(raw);
        let s = MSCORE.stripFrontMatter(raw);
        // 思源 exportMdContent 在 front matter 后固定插入一行「# 文档标题」。
        // 文档名可能被编号插件改写，按名字核对会漏；改为有 front matter 就无条件剥首个 H1。
        if (hadFm) {
            const lines = s.split(/\r?\n/);
            let i = 0;
            while (i < lines.length && /^[ \t]*$/.test(lines[i])) i++;
            const m = i < lines.length ? lines[i].match(/^#[ \t]+(.+?)\s*#*\s*$/) : null;
            if (m) { lines.splice(0, i + 1); s = lines.join("\n"); }
        }
        // D 方案：先取本文所有标题块的编号标记，剥号时精确移除，不靠正则猜
        let knownNums = [];
        try {
            const hs = await this.msSql("SELECT id FROM blocks WHERE type='h' AND root_id='" +
                                        String(id).replace(/'/g, "''") + "'");
            const nums = await this.msOwnNums((hs || []).map(r => r.id));
            knownNums = Object.keys(nums).map(k => nums[k]);
        } catch (e) {}
        let out;
        try { out = this.msStripMd(s, knownNums); } catch (e) { out = s; }
        // 思源空段落块导出成「　　‍」（全角空格 + 零宽字符），clear/append 后会残留在正文里。
        // 这类只含格式字符的行整行删掉；纯空行保留作 markdown 段落分隔。
        out = out.split(/\r?\n/).filter(l =>
            !(l.length > 0 && /^[\u3000\u200b\u200c\u200d\ufeff \t]+$/.test(l))).join("\n");
        return MSCORE.trimBlankLines(out);
    }

    async msWaitReady(id) {
        for (let i = 0; i < 20; i++) {
            try { const d = await this.msApi("/api/block/getChildBlocks", {id}); if (Array.isArray(d)) return; }
            catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error("新建文档元数据未就绪：" + id);
    }
    async msWaitIndexed(id) {
        for (let i = 0; i < 25; i++) {
            try {
                const rows = await this.msSql("SELECT id FROM blocks WHERE type='d' AND id='" + id + "' LIMIT 1");
                if (rows && rows.length) return true;
            } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }
        return false;
    }
    async msCreateDoc(box, path, markdown) {
        let last = "";
        const q = path.replace(/'/g, "''");
        for (let i = 0; i < 10; i++) {
            // 内核偶发「metadata is not ready」但文档其实已建成，先查路径复用，避免重复创建
            try {
                const rows = await this.msSql("SELECT id FROM blocks WHERE type='d' AND hpath='" + q + "' LIMIT 1");
                if (rows && rows.length && MSCORE.ID_RE.test(String(rows[0].id))) return String(rows[0].id);
            } catch (e) {}
            try {
                const made = String(await this.msApi("/api/filetree/createDocWithMd",
                    {notebook: box, path, markdown}) || "");
                if (MSCORE.ID_RE.test(made)) return made;
                last = "返回无效 ID：" + made;
            } catch (e) { last = String(e && e.message || e); }
            await new Promise(r => setTimeout(r, 700));
        }
        throw new Error("建文档失败：" + path + "（" + last + "）");
    }
    async msAppend(docId, md) {
        return this.msApi("/api/block/appendBlock", {parentID: docId, dataType: "markdown", data: md});
    }
    async msClearDoc(docId) {
        return this.msApi("/api/block/updateBlock", {id: docId, dataType: "markdown", data: ""});
    }
    async msRemoveDocs(ids) {
        for (const id of (ids || [])) await this.msApi("/api/filetree/removeDocByID", {id});
    }
    async msSubtree(node, box) {
        const listPath = String(node.path || "").replace(/\.sy$/, "") || "/";
        const d = await this.msApi("/api/filetree/listDocsByPath", {notebook: box, path: listPath});
        const files = (d && d.files) || [];
        node.children = files.filter(f => f && f.id && MSCORE.ID_RE.test(String(f.id)) &&
            String(f.name || "").indexOf("Conflicted") < 0).map(f => ({
                id: String(f.id), title: String(f.name || ""),
                path: String(f.path || (listPath + "/" + f.id + ".sy")),
                subFileCount: Number(f.subFileCount) || 0, children: [],
            }));
        for (const c of node.children) if (c.subFileCount > 0) await this.msSubtree(c, box);
        return node;
    }
    async msBackup(op, metas, extra) {
        const docs = [];
        for (const m of metas) docs.push({
            id: m.id, box: m.box, path: m.path, hpath: m.hpath,
            title: m.content || m.hpath, markdown: await this.msExport(m.id),
        });
        const x = extra || {};
        const rec = {version: 4, at: new Date().toISOString(), op, docs,
                     created: x.created || [], deleted: x.deleted || [], stripped: true};
        const file = "ms-backup-" + rec.at.replace(/[:.]/g, "-") + ".json";
        await this.saveData(file, JSON.stringify(rec, null, 2));
        return file;
    }
    /** 合并文本：各文档名作一级标题，正文标题降一级。 */
    async msCollect(metas) {
        const mds = [], names = [];
        for (const m of metas) {
            mds.push(await this.msStripMdSafe(m.id, m.content));
            names.push(this.msStripName(m.content || String(m.hpath || "").split("/").pop() || m.id));
        }
        const level = MSCORE.inferLevel(mds);
        return MSCORE.trimBlankLines(mds.map((md, i) => MSCORE.mergeSegment(names[i], md, level)).join("\n\n"));
    }
    async msWriteWhole(docId, text) {
        // 一次 updateBlock 写全文：clear(写空) + append 会遗留一个「　　‍」空段落块
        await this.msApi("/api/block/updateBlock", {id: docId, dataType: "markdown", data: text || ""});
        const rows = await this.msDocMeta([docId]);
        const after = await this.msStripMdSafe(docId, rows && rows[0] && rows[0].content);
        const a = MSCORE.normalizeForCompare(after);
        const t = MSCORE.normalizeForCompare(text);
        if (t && a !== t && a.indexOf(t) < 0) {
            throw new Error("写入校验未通过，源文档未删除。after=" + JSON.stringify(a.slice(0, 300)) +
                            " text=" + JSON.stringify(t.slice(0, 300)));
        }
    }

    /**
     * 拆/合完成后补激发「内容标题编号」（用户 11-10 10:53 口径）。
     * - 只激发本次操作涉及、且操作后仍存在的文档：被删的源文档 / 子文档不传，
     *   不做全库或全范围重排，无关文档一个数都不会被写。
     * - bodyAuto 只管「自动」触发链（当前配置为 false），这里是一次显式激发，
     *   走编号插件自己的 numberBodyRange（与右键「只编号内容标题」同一个函数）。
     * - 新建文档的文档名要等树编号（debounceMs 防抖）带上章号后 bodyPlanFor
     *   才认得 prefix，所以对「暂时算不出」的文档有限补跑几遍。
     * - 全过程只写一份 ms-last-body-numbering.json 供核查「到底激发了谁」。
     */
    async msNumberBodies(ids, tag, opt) {
        const o = opt || {};
        const all = Array.from(new Set((ids || []).map(String)))
            .filter(id => MSCORE.ID_RE.test(id));
        const cfg = this._config || {};
        const newSet = new Set((o.newIds || []).map(String));
        const rec = {at: new Date().toISOString(), tag, requested: all,
                     bodyAuto: cfg.bodyAuto === true, passes: [], skipped: []};
        if (cfg.bodyEnabled === false) {
            rec.skipped.push("bodyEnabled=false（面板已关闭内容标题编号）");
        } else {
            let pending = all.slice();
            const waits = [0, (Number(cfg.debounceMs) || 1500) + 300, 1200, 1200];
            const retryable = ["no-doc", "empty", "read-failed"];
            for (let pass = 0; pass < waits.length && pending.length; pass++) {
                if (waits[pass]) await new Promise(r => setTimeout(r, waits[pass]));
                // 尊重编号插件自己的「自动编号范围」：范围外的文档不激发
                const scope = [];
                for (const id of pending) {
                    let inside = true;
                    try { inside = await this.docInTargets(id); } catch (e) { inside = true; }
                    if (inside) scope.push(id);
                    else if (pass === 0) rec.skipped.push(id + ":out-of-scope");
                }
                if (!scope.length) break;
                try {
                    const r = await this.numberBodyRange(scope,
                        {source: "merge-split:" + tag, silent: true});
                    rec.passes.push({pass, ids: scope, ok: !!r.ok,
                        docsHit: r.docsHit || 0, changed: r.changed || 0,
                        docs: (r.docs || []).map(d => ({docId: d.docId, ok: !!d.ok,
                            reason: d.reason || "", changed: d.changed || 0}))});
                    const retry = new Set((r.docs || []).filter(d =>
                        retryable.indexOf(d.reason) >= 0 ||
                        (d.reason === "no-prefix" && newSet.has(String(d.docId)))
                    ).map(d => String(d.docId)));
                    pending = pending.filter(id => retry.has(id));
                } catch (e) {
                    rec.passes.push({pass, ids: scope, ok: false,
                                     error: String(e && e.message || e)});
                    break;
                }
            }
        }
        try { await this.saveData("ms-last-body-numbering.json", JSON.stringify(rec, null, 2)); }
        catch (e) { rec.saveError = String(e && e.message || e); }
        console.info("[merge-split] 正文编号激发", tag,
                     JSON.stringify(rec.passes.map(p => p.ids)));
        return rec;
    }

    async msRun(op, targets) {
        console.info("[merge-split] op=", op, "count=", targets.length,
                     "ids=", targets.map(t => t.id).join(","));
        if (op === "merge-many" && targets.length < 2) throw new Error("请至少选中两篇文档");
        const ids = targets.map(t => t.id);
        const meta = await this.msDocMeta(ids);
        const byId = {};
        meta.forEach(m => { byId[m.id] = m; });
        if (!meta.length) throw new Error("读不到文档元数据，已终止（零写入）");
        if (op === "merge-children") return this.msMergeChildren(targets[0], byId[targets[0].id]);
        if (op === "merge-many") return this.msMergeMany(targets, byId);
        if (op === "split-sub" || op === "split-sibling") return this.msSplit(targets[0], byId[targets[0].id], op);
        throw new Error("未知操作：" + op);
    }

    /** 功能 3：把子文档合并到父文档末尾，文档名作一级标题、正文标题降一级，删子文档。 */
    async msMergeChildren(target, meta) {
        if (!meta) throw new Error("读不到目标文档元数据");
        const root = {id: target.id, path: meta.path, children: []};
        await this.msSubtree(root, meta.box);
        const allIds = MSCORE.flattenTree(root);
        const topIds = MSCORE.topLevelIds(root);
        if (!allIds.length) throw new Error("该文档没有子文档，未做任何改动");
        const nodeById = {};
        (function walk(n) { ((n && n.children) || []).forEach(c => { nodeById[c.id] = c; walk(c); }); })(root);
        const ordered = allIds.map(id => {
            const c = nodeById[id] || {};
            return {id, box: meta.box, path: c.path || "", hpath: "", content: c.title || id};
        });
        const backupFile = await this.msBackup("merge-children", [meta].concat(ordered),
                                               {target: target.id, deleted: topIds});
        const text = await this.msCollect(ordered);
        if (!text) throw new Error("子文档内容为空，未做任何改动");
        try {
            // 一次写整篇（原内容 + 新段），不用 appendBlock：追加会把思源自带的
            // 「　　‍」空段落块夹在中间，用户看到的就是「又多了个空行」。
            const rows = await this.msDocMeta([target.id]);
            const base = await this.msStripMdSafe(target.id, rows && rows[0] && rows[0].content);
            const combined = MSCORE.trimBlankLines([base, text].filter(Boolean).join("\n\n"));
            await this.msWriteWhole(target.id, combined);
        } catch (e) { throw new Error(e.message + "。备份：" + backupFile); }
        await this.msRemoveDocs(topIds);
        // 只激发父文档：子文档已删除，不在「相关且仍存在」的集合里
        await this.msNumberBodies([target.id], "merge-children");
        return "已合并 " + ordered.length + " 篇子文档到父文档末尾（编号已剔除，已补编号）。备份：" + backupFile;
    }

    /** 功能 4：选中若干文档 → 新建平行文档【合并文档】，删选中文档。 */
    async msMergeMany(targets, byId) {
        const metas = targets.map(t => byId[t.id]).filter(Boolean);
        if (metas.length < 2) throw new Error("至少要有两篇可读到的文档");
        const first = metas[0];
        let baseHpath = "";
        try { baseHpath = String(await this.msApi("/api/filetree/getHPathByID", {id: first.id}) || ""); } catch (e) {}
        if (!baseHpath || baseHpath === "/") baseHpath = first.hpath || "";
        if (!first.box || !baseHpath) throw new Error("读不到笔记本或路径，未做任何改动");
        const backupFile = await this.msBackup("merge-many", metas, {deleted: metas.map(m => m.id)});
        const text = await this.msCollect(metas);
        if (!text) throw new Error("参与文档内容为空，未做任何改动");
        const pos = await this.msUniqueSiblingPath(baseHpath, MSCORE.CFG.MERGE_DOC_NAME);
        const made = await this.msCreateDoc(first.box, pos.path, "");
        await this.msWaitReady(made);
        await this.msWaitIndexed(made);
        try { await this.msWriteWhole(made, text); }
        catch (e) { throw new Error(e.message + "。新文档 " + made + "，备份：" + backupFile); }
        await this.msRemoveDocs(metas.map(m => m.id));
        // 只激发新建的【合并文档】：选中的源文档已删除
        await this.msNumberBodies([made], "merge-many", {newIds: [made]});
        return "已把 " + metas.length + " 篇合并为「" + pos.name + "」（编号已剔除，已补编号）。备份：" + backupFile;
    }
    /** Q4：同名已存在时自动加序号（合并文档 2、3…）。 */
    async msUniqueSiblingPath(hpath, base) {
        for (let i = 1; i <= 50; i++) {
            const name = i === 1 ? base : base + " " + i;
            const path = MSCORE.hpathSibling(hpath, name);
            const q = path.replace(/'/g, "''");
            let used = false;
            try {
                const rows = await this.msSql("SELECT id FROM blocks WHERE type='d' AND hpath='" + q + "' LIMIT 1");
                used = !!(rows && rows.length);
            } catch (e) { used = false; }
            if (!used) return {name, path};
        }
        throw new Error("无法确定可用的合并文档名");
    }

    /** 功能 1/2：按最高层级标题拆分；原最高层标题变文档名不显示，其余标题提升一级。 */
    async msSplit(target, meta, op) {
        const md = await this.msStripMdSafe(target.id, meta.content);
        const level = MSCORE.detectTopLevel(md);
        if (!level) throw new Error("整个内容没有任何标题，不拆分");
        const parts = MSCORE.splitByLevel(md, level);
        if (!parts.sections.length) throw new Error("未切出任何章节，不拆分");
        // 编号插件可能刚给文档改名，缓存的 meta.hpath 会过期 → 建子文档时内核报
        // "document metadata is not ready"。实时查一次，失败再回退缓存。
        let hpath = "";
        try { hpath = String(await this.msApi("/api/filetree/getHPathByID", {id: target.id}) || ""); } catch (e) {}
        if (!hpath || hpath === "/") hpath = meta.hpath || "";
        const box = meta.box || target.box;
        if (!box) throw new Error("读不到笔记本 ID，未做任何改动");
        const backupFile = await this.msBackup(op, [meta], {target: target.id, level});
        const created = [];
        for (const sec of parts.sections) {
            const name = this.msStripName(sec.title);
            const path = (op === "split-sub") ? MSCORE.hpathChild(hpath, name)
                                             : MSCORE.hpathSibling(hpath, name);
            const body = MSCORE.promoteBody(sec.body);      // 其余标题提升一级；原最高层标题不写入
            const made = await this.msCreateDoc(box, path, body);
            await this.msWaitReady(made);
            await this.msWaitIndexed(made);
            created.push(made);
            // 连续建文档会与自动编号 / 同步抢元数据，留一点间隔避免下一次 metadata not ready
            await new Promise(r => setTimeout(r, 500));
        }
        // 原文档：一次 updateBlock 只写一级标题前的文本，避免 clear+append 留下空段落块
        const preamble = MSCORE.trimBlankLines(parts.preamble);
        await this.msApi("/api/block/updateBlock",
            {id: target.id, dataType: "markdown", data: preamble || ""});
        // 「拆分为多个平行文档」且清空后内容为空 → 删除原文档（用户 10:17 补充）
        let removedSource = false;
        if (op === "split-sibling" && !preamble && MSCORE.CFG.DELETE_EMPTY_SIBLING_SOURCE) {
            await this.msRemoveDocs([target.id]);
            removedSource = true;
        }
        // 只激发本次新建的文档 + 仍保留的原文档；已删的原文档不传
        const related = created.slice();
        if (!removedSource) related.push(target.id);
        await this.msNumberBodies(related, op, {newIds: created});
        return "已拆为 " + created.length + " 个" + (op === "split-sub" ? "子文档" : "平行文档") +
               "；原文档" + (removedSource ? "内容为空，已删除" : "仅保留前言") + "。备份：" + backupFile;
    }
