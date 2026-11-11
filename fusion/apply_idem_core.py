# -*- coding: utf-8 -*-
"""v1.2.2 正文编号幂等修复补丁步。

问题：D 方案（按 bn 属性精确剥离）把「剥掉编号后的裸标题」传给 buildBodyPlan，
而后者拿 to（带编号）与 b.markdown（剥后裸标题）比较 → 永远不相等 →
每轮都生成满篇「改动」、把相同内容重写一遍 → 写回触发标题变化事件 →
自动重算自激循环 → 连续 3 轮熔断，弹出「正文编号连续 3 轮都算出不同结果」。

修法：把剥离前的原始 markdown 另存为 original 传进去，幂等判定与撤销快照的
from 都以原文为准；再在 bodyPlanFor 用本轮已读到的 mdMap 做零成本兜底。
全程不新增任何 API 请求。

由 apply.py 在 apply_level_core 之后执行。每处替换都断言锚点命中次数。
请勿缩进本文件。
"""
def bp(old, new, n=1, label=""):
    global s
    c = s.count(old)
    assert c == n, "IDEM-%s 锚点命中 %d 次（期望 %d）: %r" % (label, c, n, old[:80])
    s = s.replace(old, new, n)


# ---------------------------------------------------------------- I0
# buildBodyPlan 的第一层 map 会把未列出的字段丢掉，original 必须在这里透传。
bp(r'''        var blocks = (o.blocks || []).map(function (b) {
            var lv = Number(b.level) || 0;
            if (focus && String(b.id) === String(focus.id)) lv = Number(focus.level) || lv;
            return {id: b.id, level: lv, markdown: String(b.markdown == null ? "" : b.markdown),
                    preStripped: !!b.preStripped};
        });''',
   r'''        var blocks = (o.blocks || []).map(function (b) {
            var lv = Number(b.level) || 0;
            if (focus && String(b.id) === String(focus.id)) lv = Number(focus.level) || lv;
            /* v1.2.2：original 必须透传到下一层，否则幂等基准会退回剥后裸标题 */
            return {id: b.id, level: lv, markdown: String(b.markdown == null ? "" : b.markdown),
                    original: b.original != null ? String(b.original) : null,
                    preStripped: !!b.preStripped};
        });''', 1, "blocks passthrough")


# ---------------------------------------------------------------- I1
# buildBodyPlan：items 保留剥离前原文。
bp(r'''        var items = blocks.map(function (b) {
            var focused = !!(focus && String(b.id) === String(focus.id));
            var parts = splitMarkdown(b.markdown);
            var eff = focused ? (Number(b.level) || 0)
                             : (parts.hashes ? parts.hashes.length : 0);
            return {id: b.id, level: eff, markdown: b.markdown,
                    focused: focused, parts: parts, preStripped: !!b.preStripped};
        });''',
   r'''        var items = blocks.map(function (b) {
            var focused = !!(focus && String(b.id) === String(focus.id));
            var parts = splitMarkdown(b.markdown);
            var eff = focused ? (Number(b.level) || 0)
                             : (parts.hashes ? parts.hashes.length : 0);
            /* v1.2.2：D 方案传进来的 markdown 是「剥掉编号后的裸标题」，
             * 必须另存剥离前原文，幂等判定和撤销快照的 from 都以原文为准。 */
            return {id: b.id, level: eff, markdown: b.markdown,
                    original: b.original != null ? b.original : b.markdown,
                    focused: focused, parts: parts, preStripped: !!b.preStripped};
        });''', 1, "items original")


# ---------------------------------------------------------------- I2
# 幂等判定基准 + 撤销快照 from。
bp(r'''            if (to.trimEnd() !== String(b.markdown).trimEnd()) {
                plan.push({id: b.id, from: b.markdown, to: to, level: lv, levelNorm: nl,
                           number: numCore});
            }''',
   r'''            /* v1.2.2 修复「连续 3 轮算出不同结果」误报：以前拿 to（带编号）
             * 跟 b.markdown（剥后裸标题）比，永远不相等 → 每轮重写相同内容 →
             * 触发标题变化事件 → 自动重算自激循环。改用剥离前原文比较；
             * from 也用原文，撤销快照记的才是真实旧值。 */
            var cmpMd = String(b.original != null ? b.original : b.markdown).trimEnd();
            if (to.trimEnd() !== cmpMd) {
                plan.push({id: b.id, from: cmpMd, to: to, level: lv, levelNorm: nl,
                           number: numCore});
            }''', 1, "idempotent compare")


# ---------------------------------------------------------------- I3
# bodyPlanFor 与快捷键路径（两处同文本）：blocks 带上 original。
bp(r'''        const blocks = ordered.map((b) => {
            const peeled = this.msStrictPeel(mdMap.get(b.id) || "", ownNums[String(b.id)]);
            return {id: b.id, level: b.level, markdown: peeled.markdown,
                    preStripped: peeled.hit};
        });''',
   r'''        const blocks = ordered.map((b) => {
            const rawMd = mdMap.get(b.id) || "";
            const peeled = this.msStrictPeel(rawMd, ownNums[String(b.id)]);
            /* v1.2.2：original 保留剥离前原文，供 buildBodyPlan 做幂等比较 */
            return {id: b.id, level: b.level, markdown: peeled.markdown,
                    original: rawMd, preStripped: peeled.hit};
        });''', 2, "blocks original x2")


# ---------------------------------------------------------------- I4
# bodyPlanFor 的安全闸：用本轮已读到的 mdMap 再挡一次「目标==现状」。
# 不重读 markdown，不新增任何 API 请求。
bp(r'''        const safe = r.plan.filter((p) => String(p.to || "").replace(/^#+\s*/, "").trim());''',
   r'''        const safe = r.plan.filter((p) => {
            if (!String(p.to || "").replace(/^#+\s*/, "").trim()) return false;
            /* v1.2.2 零成本兜底：mdMap 是这一轮刚读到的原始 markdown，
             * 目标与现状逐字相同就不必写（写也会触发标题变化事件）。 */
            const cur = mdMap.get(p.id);
            return cur == null || String(cur).trimEnd() !== String(p.to).trimEnd();
        });''', 1, "plan no-op guard")
