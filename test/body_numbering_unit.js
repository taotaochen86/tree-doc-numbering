#!/usr/bin/env node
/* 正文标题编号核心 · 离线单测（v0.5.0，Q18 口径）
 * 跑法：node test/body_numbering_unit.js
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
require("../src/numbering.js");        // 先加载：数字格式化实现挂在 globalThis，内容侧共用
const BN = require("../src/body_numbering.js");

function B(id, level, body) {
    return {id, level, markdown: (level ? "#".repeat(level) + " " : "") + body};
}
function run(docTitle, blocks, focus) {
    return BN.buildBodyPlan({docTitle: docTitle, blocks: blocks, focus: focus});
}
function byId(plan, id) {
    return plan.find((p) => p.id === id);
}
function applied(blocks, plan) {
    const m = new Map(plan.map((p) => [p.id, p.to]));
    return blocks.map((b) => ({id: b.id, level: b.level, markdown: m.has(b.id) ? m.get(b.id) : b.markdown}));
}

test("G1 节编号优先：第1.1节 → 1.1", () => {
    assert.deepEqual(BN.extractPrefix("第1.1节 Rstudio相关配置"), {value: "1.1", kind: "节"});
    assert.deepEqual(BN.extractPrefix("第2.3节 ggplot2"), {value: "2.3", kind: "节"});
    assert.deepEqual(BN.extractPrefix("第3.1节 含「章」字的标题"), {value: "3.1", kind: "节"});
});

test("G2 没有节编号时取章编号：第3章 → 3", () => {
    assert.deepEqual(BN.extractPrefix("第3章 回归与拟合"), {value: "3", kind: "章"});
    assert.deepEqual(BN.extractPrefix("第12章 附注"), {value: "12", kind: "章"});
});

test("G3 既无节号也无章号：跳过、不生成任何改名", () => {
    /* v0.7.7 口径变更：`1【绪论】` / `【1】研究背景` / `第1部 …` 原本判 no-prefix，
     * 但它们正是**树编号模板自己写出来的形态**（用户【专业笔记】的一级文档就叫【1】氮循环），
     * 不认就自相矛盾。现在这三种都认作章号，所以本用例改用真正无号的标题。 */
    assert.equal(BN.extractPrefix("前言"), null);
    assert.equal(BN.extractPrefix("编写说明"), null);
    assert.equal(BN.extractPrefix("About"), null);
    const r = run("前言", [B("a", 1, "一级")]);
    assert.equal(r.reason, "no-prefix");
    assert.equal(r.plan.length, 0);
});

test("G4 五级完整输出逐字符合用户口径", () => {
    const blocks = [B("a", 1, "一级"), B("b", 2, "二级"), B("c", 3, "三级"),
                    B("d", 4, "四级"), B("e", 5, "五级")];
    const r = run("第1.1节 取样", blocks);
    assert.equal(r.prefix, "1.1");
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 一级");
    assert.equal(byId(r.plan, "b").to, "## 1.1.1.1 二级");
    assert.equal(byId(r.plan, "c").to, "### （1）三级");
    assert.equal(byId(r.plan, "d").to, "#### 1）四级");
    assert.equal(byId(r.plan, "e").to, "##### ①五级");
});

test("G5 章号兜底：一级 3.1、二级 3.1.1", () => {
    const r = run("第3章 回归与拟合", [B("a", 1, "一级"), B("b", 2, "二级")]);
    assert.equal(r.prefixKind, "章");
    assert.equal(byId(r.plan, "a").to, "# 3.1 一级");
    assert.equal(byId(r.plan, "b").to, "## 3.1.1 二级");
});

test("G6 多个 H1 连号，H2 按所属 H1 重排", () => {
    const blocks = [B("h1a", 1, "A"), B("s1", 2, "a1"), B("s2", 2, "a2"),
                    B("h1b", 1, "B"), B("s3", 2, "b1"), B("s4", 2, "b2")];
    const r = run("第1.1节 取样", blocks);
    assert.equal(byId(r.plan, "h1a").to, "# 1.1.1 A");
    assert.equal(byId(r.plan, "h1b").to, "# 1.1.2 B");
    assert.equal(byId(r.plan, "s1").to, "## 1.1.1.1 a1");
    assert.equal(byId(r.plan, "s2").to, "## 1.1.1.2 a2");
    assert.equal(byId(r.plan, "s3").to, "## 1.1.2.1 b1");
    assert.equal(byId(r.plan, "s4").to, "## 1.1.2.2 b2");
});

test("G7 括号 / 圈码序号按所属上级重排", () => {
    const blocks = [B("h", 1, "A"), B("h2a", 2, "a"), B("x1", 3, "三"), B("y1", 4, "四"), B("z1", 5, "五"),
                    B("h2b", 2, "b"), B("x2", 3, "三2"), B("y2", 4, "四2"), B("z2", 5, "五2")];
    const r = run("第2.3节 正文", blocks);
    assert.equal(byId(r.plan, "x1").to, "### （1）三");
    assert.equal(byId(r.plan, "x2").to, "### （1）三2", "换 H2 后 H3 回 1");
    assert.equal(byId(r.plan, "y1").to, "#### 1）四");
    assert.equal(byId(r.plan, "y2").to, "#### 1）四2", "换 H3 后 H4 回 1");
    assert.equal(byId(r.plan, "z1").to, "##### ①五");
    assert.equal(byId(r.plan, "z2").to, "##### ①五2", "换 H4 后 H5 回 1");
});

test("G8 连跑两遍幂等：第二遍没有任何待改项", () => {
    const blocks = [B("a", 1, "一级"), B("b", 2, "二级"), B("c", 3, "三级"),
                    B("d", 4, "四级"), B("e", 5, "五级")];
    const r1 = run("第1.1节 取样", blocks);
    const r2 = run("第1.1节 取样", applied(blocks, r1.plan));
    assert.equal(r2.plan.length, 0, JSON.stringify(r2.plan));
});

test("G9 换编号先剥旧号，不叠加前缀", () => {
    const blocks = [
        {id: "a", level: 1, markdown: "# 9.9.9 旧的一级"},
        {id: "c", level: 3, markdown: "### （7）旧三级"},
        {id: "d", level: 4, markdown: "#### 8）旧四级"},
        {id: "e", level: 5, markdown: "##### ⑨旧五级"},
    ];
    const r = run("第1.1节 取样", blocks);
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 旧的一级");
    assert.equal(byId(r.plan, "c").to, "### （1）旧三级");
    assert.equal(byId(r.plan, "d").to, "#### 1）旧四级");
    assert.equal(byId(r.plan, "e").to, "##### ①旧五级");
});

test("G10 保留 <sub> 与 ** 等内联 markdown", () => {
    const r = run("第1.1节 取样", [{id: "a", level: 1,
        markdown: "# 一级含<sub>下标</sub> **粗**"}]);
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 一级含<sub>下标</sub> **粗**");
});

test("G11 快捷键把普通段落设为 H2，后续编号级联重算", () => {
    const blocks = [B("h", 1, "A"), B("p", 0, "段落X"), B("s1", 2, "b"), B("s2", 2, "c")];
    const r = run("第1.1节 取样", blocks, {id: "p", level: 2});
    assert.equal(byId(r.plan, "p").to, "## 1.1.1.1 段落X", "当前段落就地转成标题并编号");
    assert.equal(byId(r.plan, "s1").to, "## 1.1.1.2 b", "后面的 H2 顺延");
    assert.equal(byId(r.plan, "s2").to, "## 1.1.1.3 c");
    assert.equal(byId(r.plan, "h").to, "# 1.1.1 A", "整篇重算：原本没编号的前置 H1 一并补号");
    // 稳态：前面已经编号的块不动，只有当前段落与后面的块顺延
    const settled = [
        {id: "h", level: 1, markdown: "# 1.1.1 A"},
        {id: "p", level: 0, markdown: "段落X"},
        {id: "s", level: 2, markdown: "## 1.1.1.1 b"},
    ];
    const r3 = run("第1.1节 取样", settled, {id: "p", level: 2});
    assert.equal(byId(r3.plan, "h"), undefined, "前面已编号的 H1 不变，不写库");
    assert.equal(byId(r3.plan, "p").to, "## 1.1.1.1 段落X");
    assert.equal(byId(r3.plan, "s").to, "## 1.1.1.2 b", "后面的 H2 顺延");
    // 未被 focus 的普通段落永远不写
    const r2 = run("第1.1节 取样", [B("h", 1, "A"), B("p", 0, "普通段落"), B("s", 2, "b")]);
    assert.equal(byId(r2.plan, "p"), undefined);
});

test("G12 H6 及更深不编号、也不剥旧号", () => {
    const blocks = [B("a", 1, "一级"), B("h6", 6, "第六级")];
    const r = run("第1.1节 取样", blocks);
    assert.equal(byId(r.plan, "h6"), undefined);
});

test("G13 圈码超过 20 退化为全角（21），且仍幂等", () => {
    const blocks = [B("h", 1, "A")];
    for (let i = 0; i < 21; i++) blocks.push(B("z" + i, 5, "五" + i));
    const r = run("第1.1节 取样", blocks);
    assert.equal(byId(r.plan, "z19").to, "##### ⑳五19");
    assert.equal(byId(r.plan, "z20").to, "##### （21）五20");
    assert.equal(run("第1.1节 取样", applied(blocks, r.plan)).plan.length, 0);
});

test("G14 中文数字标题不被误剥", () => {
    const r = run("第1.1节 取样", [{id: "a", level: 1, markdown: "# 第一章 绪论"}]);
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 第一章 绪论");
});

test("G15 已知代价：手写「1.1 结果」会被当成旧编号剥掉（如实锁定）", () => {
    const r = run("第1.1节 取样", [{id: "a", level: 1, markdown: "# 1.1 结果"}]);
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 结果");
});

/* ---------------- v0.5.1 模板化（面板「正文标题编号」设置的底层） ---------------- */

test("G16 normalizeBodyFormats 补齐空模板与缺级，全部回退内置默认", () => {
    const n = BN.normalizeBodyFormats({1: "", 3: "【{n}】"});
    assert.equal(n[1], BN.BUILTIN_BODY_FORMATS[1]);
    assert.equal(n[2], BN.BUILTIN_BODY_FORMATS[2]);
    assert.equal(n[3], "【{n}】");
    assert.equal(n[4], BN.BUILTIN_BODY_FORMATS[4]);
    assert.equal(n[5], BN.BUILTIN_BODY_FORMATS[5]);
    assert.deepEqual(BN.normalizeBodyFormats(null),
                     BN.normalizeBodyFormats(BN.BUILTIN_BODY_FORMATS));
});

test("G17 默认模板渲染与旧硬编码输出逐字一致（不传 formats）", () => {
    const ctx = {prefix: "1.1", n: "2", h1: "1.1.1", cn: "②"};
    assert.equal(BN.renderBodyTemplate(BN.BUILTIN_BODY_FORMATS[1], 1, ctx), "1.1.2");
    assert.equal(BN.renderBodyTemplate(BN.BUILTIN_BODY_FORMATS[2], 2, ctx), "1.1.1.2");
    assert.equal(BN.renderBodyTemplate(BN.BUILTIN_BODY_FORMATS[3], 3, ctx), "（2）");
    assert.equal(BN.renderBodyTemplate(BN.BUILTIN_BODY_FORMATS[4], 4, ctx), "2）");
    assert.equal(BN.renderBodyTemplate(BN.BUILTIN_BODY_FORMATS[5], 5, ctx), "②");
    // 空模板回退该级内置默认
    assert.equal(BN.renderBodyTemplate("", 4, ctx), "2）");
});

test("G18 自定义三级模板：渲染新形态、剥掉旧内置号、再跑幂等", () => {
    const formats = BN.normalizeBodyFormats({3: "【{n}】"});
    // 旧形态是内置（1）（2）……；stripFormats 带上内置才能剥旧
    const blocks = [B("a", 1, "一级"), {id: "c", level: 3, markdown: "### （3）旧三级"}];
    const r1 = BN.buildBodyPlan({docTitle: "第1.1节 取样", blocks: blocks,
                                 formats: formats,
                                 stripFormats: [formats, BN.BUILTIN_BODY_FORMATS]});
    assert.equal(byId(r1.plan, "c").to, "### 【1】旧三级");
    const applied1 = applied(blocks, r1.plan);
    const r2 = BN.buildBodyPlan({docTitle: "第1.1节 取样", blocks: applied1,
                                 formats: formats,
                                 stripFormats: [formats, BN.BUILTIN_BODY_FORMATS]});
    assert.equal(r2.plan.length, 0, JSON.stringify(r2.plan));
});

test("G19 {h1} 跟踪所属一级的真实渲染号；非数字收尾不自动加空格", () => {
    const formats = BN.normalizeBodyFormats({1: "{prefix}({n})", 2: "{h1}·{n}"});
    const blocks = [B("a", 1, "A"), B("s1", 2, "a"), B("b", 1, "B"), B("s2", 2, "b")];
    const r = BN.buildBodyPlan({docTitle: "第1.1节 取样", blocks: blocks, formats: formats});
    /* v0.8.1 口径变更：{h1} 从「模板 1 的渲染结果」改成「纯号 prefix.序号」。
     * 老口径下模板 1 带装饰（如 `{prefix}({n})`）时，二级标题会写成 `1.1(1)·1`，
     * 而剥号只认数字开头，下一轮再拼一次 → 编号越来越长（真机 14 段）。
     * 纯号既能被剥，也和 {prefix} 同源：第 1 个一级 = 1.1.1，第 2 个 = 1.1.2。 */
    assert.equal(byId(r.plan, "a").to, "# 1.1(1)A", "以 ) 收尾：不自动补空格");
    assert.equal(byId(r.plan, "s1").to, "## 1.1.1·1 a");
    assert.equal(byId(r.plan, "b").to, "# 1.1(2)B");
    assert.equal(byId(r.plan, "s2").to, "## 1.1.2·1 b");
    // 想带空格：模板末尾自己写空格；剥号正则带 \s*，幂等不受影响
    const f2 = BN.normalizeBodyFormats({1: "{prefix}({n}) "});
    const r2 = BN.buildBodyPlan({docTitle: "第1.1节 取样",
        blocks: [{id: "a", level: 1, markdown: "# 1.1(1) A"}], formats: f2});
    assert.equal(r2.plan.length, 0, JSON.stringify(r2.plan));
    const r3 = BN.buildBodyPlan({docTitle: "第1.1节 取样",
        blocks: [{id: "a", level: 1, markdown: "# A"}], formats: f2});
    assert.equal(byId(r3.plan, "a").to, "# 1.1(1) A", "模板尾空格原样生效");
});

test("G20 bodyStripRegex 字面量逐个转义，特殊字符模板不炸、能剥", () => {
    const re = BN.bodyStripRegex("[{n}]");
    assert.ok(re, "特殊字符模板应生成合法正则");
    assert.ok(re.test("[3] 标题"));
    assert.ok(!re.test("（3） 标题"));
    const re2 = BN.bodyStripRegex("{n}.");
    assert.ok(re2.test("1. 标题"), "半角点也是字面量");
    assert.equal(BN.bodyStripRegex("  "), null, "空模板返回 null");
});

/* ---------------- v0.5.0 真机事故修复（2026-11-07 15:45 用户报告「标题消失」） ---------------- */

test("G21 {title} 模板：标题由模板控制位置，已编号标题幂等", () => {
    const formats = BN.normalizeBodyFormats({1: "{prefix}.{n} {title}"});
    // 未编号 → 按模板渲染
    const r1 = BN.buildBodyPlan({docTitle: "第1章 前言",
        blocks: [{id: "a", level: 1, markdown: "# 试验设计的意义和任务"}], formats: formats});
    assert.equal(byId(r1.plan, "a").to, "# 1.1 试验设计的意义和任务");
    // 已编号 → 幂等（旧号被剥掉再由模板拼回）
    const r2 = BN.buildBodyPlan({docTitle: "第1章 前言",
        blocks: [{id: "a", level: 1, markdown: "# 1.1 试验设计的意义和任务"}], formats: formats});
    assert.equal(r2.plan.length, 0, JSON.stringify(r2.plan));
    // 手写数字编号照剥（与内置同形，已知代价口径一致）
    const r3 = BN.buildBodyPlan({docTitle: "第1章 前言",
        blocks: [{id: "a", level: 1, markdown: "# 2.5 旧号标题"}], formats: formats});
    assert.equal(byId(r3.plan, "a").to, "# 1.1 旧号标题");
});

test("G22 {h1} 只引用纯编号：一级模板带 {title} 时二级不掺上级标题文字", () => {
    const formats = BN.normalizeBodyFormats({1: "{prefix}.{n} {title}", 2: "{h1}.{n} {title}"});
    const blocks = [B("a", 1, "取样方法"), B("s", 2, "样品处理")];
    const r = BN.buildBodyPlan({docTitle: "第1.1节 取样", blocks: blocks, formats: formats});
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 取样方法");
    assert.equal(byId(r.plan, "s").to, "## 1.1.1.1 样品处理", "{h1} 不带标题文字");
});

test("G23 读不到内容的块一律跳过，绝不生成改名项（防清空标题）", () => {
    const blocks = [B("a", 1, "一级"), {id: "bad", level: 3, markdown: ""},
                    {id: "blank", level: 1, markdown: "   "}, B("b", 2, "二级")];
    const r = run("第1.1节 取样", blocks);
    assert.equal(byId(r.plan, "bad"), undefined, "空 md 块不写");
    assert.equal(byId(r.plan, "blank"), undefined, "纯空白 md 块不写");
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 一级");
    assert.equal(byId(r.plan, "b").to, "## 1.1.1.1 二级", "正常块照常编号");
});

test("G24 剥号正则在 {title} 处截断；单独 {title} 模板返回 null", () => {
    const re = BN.bodyStripRegex("{prefix}.{n} {title}");
    assert.ok(re.test("1.1 试验设计的意义和任务"), "剥号 + 分隔空格");
    assert.ok(re.test("1.1"), "号后无空格也能剥");
    assert.ok(!re.test("试验设计的意义和任务"), "没有号就不剥，绝不吞标题");
    assert.equal(BN.bodyStripRegex("{title}"), null, "没有号可剥");
    // 标题文字里的字面占位符不会被二次展开（单遍替换）
    const r = BN.buildBodyPlan({docTitle: "第1.1节 取样",
        blocks: [{id: "a", level: 1, markdown: "# {n}试验"}],
        formats: BN.normalizeBodyFormats({1: "{prefix}.{n} {title}"})});
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 {n}试验", "{n} 字样原样保留");
});

/* ---- v0.6.1 文档内深度归一（2026-11-07 用户定） ---- */
function runN(docTitle, blocks, extra) {
    return BN.buildBodyPlan(Object.assign({docTitle: docTitle, blocks: blocks,
                                           normalizeDepth: true}, extra || {}));
}

test("G25 深度归一：没有 H1 的节级文档，最浅的 H2 当一级 → 顶标题 5.1.1", () => {
    const blocks = [B("a", 2, "加载环境与数据准备"), B("b", 3, "安装包"), B("c", 3, "加载R包"),
                    B("d", 2, "第二个二级")];
    const r = runN("第5.1节 随机区组试验", blocks);
    assert.equal(r.depthShift, 1, "最浅 H2 → shift 1");
    assert.equal(byId(r.plan, "a").to, "## 5.1.1 加载环境与数据准备");
    // 归一只改「用第几级模板」，五级模板本身照旧：二级仍是 {h1}.{n}
    assert.equal(byId(r.plan, "b").to, "### 5.1.1.1 安装包");
    assert.equal(byId(r.plan, "c").to, "### 5.1.1.2 加载R包");
    assert.equal(byId(r.plan, "d").to, "## 5.1.2 第二个二级");
});

test("G26 深度归一不影响有 H1 的文档（shift=0，与旧行为逐字一致）", () => {
    const blocks = [B("a", 1, "一级"), B("b", 2, "二级"), B("c", 3, "三级")];
    const r = runN("第1.1节 取样", blocks);
    assert.equal(r.depthShift, 0);
    assert.equal(byId(r.plan, "a").to, "# 1.1.1 一级");
    assert.equal(byId(r.plan, "b").to, "## 1.1.1.1 二级");
    assert.equal(byId(r.plan, "c").to, "### （1）三级");
});

test("G27 深度归一后可收敛（幂等）：同一批内容连跑两遍不再改", () => {
    const blocks = [B("a", 2, "顶一"), B("b", 3, "子一"), B("c", 2, "顶二")];
    const r1 = runN("第3.4节 grid系统", blocks);
    const after = applied(blocks, r1.plan);
    const r2 = runN("第3.4节 grid系统", after);
    assert.equal(r2.plan.length, 0, "第二遍零改动：" + JSON.stringify(r2.plan));
});

test("G28 深度归一：从 H3 起编的文档，H3 当一级、{h1} 跟着归一号走", () => {
    const blocks = [B("a", 3, "甲"), B("b", 4, "甲子"), B("c", 3, "乙")];
    const r = runN("第6.1节 随机森林模型", blocks);
    assert.equal(r.depthShift, 2);
    assert.equal(byId(r.plan, "a").to, "### 6.1.1 甲");
    assert.equal(byId(r.plan, "b").to, "#### 6.1.1.1 甲子", "H4 归一到二级 → {h1}.{n}");
    assert.equal(byId(r.plan, "c").to, "### 6.1.2 乙");
});

test("G29 不开归一（normalizeDepth 缺省）时维持字面级别，老调用方不受影响", () => {
    const r = BN.buildBodyPlan({docTitle: "第5.1节 随机区组试验",
        blocks: [B("a", 2, "加载环境")]});
    assert.equal(r.depthShift, 0);
    assert.equal(byId(r.plan, "a").to, "## 5.1.1.1 加载环境", "字面 H2 → 二级 4 段");
});

test("G30 归一后掉出 1~5 级的极深标题不动", () => {
    const blocks = [B("a", 2, "顶"), B("b", 6, "六级")];
    const r = runN("第5.1节 x", blocks);
    assert.equal(r.depthShift, 1);
    assert.equal(byId(r.plan, "b"), undefined, "H6 归一后仍在 1~5 之外 → 不编");
});

/* ---- v0.6.3 纯数字节号前缀（树编号第 2 级模板的产出形态） ---- */
test("G31 认「2.1 BBBBB」这种无「第/节」的纯数字节号", () => {
    assert.deepEqual(BN.extractPrefix("2.1 BBBBB"), {value: "2.1", kind: "节"});
    assert.deepEqual(BN.extractPrefix("10.12 冗余分析"), {value: "10.12", kind: "节"});
    assert.deepEqual(BN.extractPrefix("2.1、标题"), {value: "2.1", kind: "节"});
    const r = BN.buildBodyPlan({docTitle: "2.1 BBBBB",
        blocks: [B("a", 1, "但是发生大法师"), B("b", 1, "你书稿现在的状态")]});
    assert.equal(byId(r.plan, "a").to, "# 2.1.1 但是发生大法师");
    assert.equal(byId(r.plan, "b").to, "# 2.1.2 你书稿现在的状态");
});

test("G32 「第N.N节」优先于纯数字形态，且互不误伤", () => {
    assert.deepEqual(BN.extractPrefix("第2.1节 Rstudio相关配置"), {value: "2.1", kind: "节"});
    assert.deepEqual(BN.extractPrefix("第3章 Tidyverse教程"), {value: "3", kind: "章"});
    assert.equal(BN.extractPrefix("2024 年度总结"), null, "四位整数不算号");
    assert.equal(BN.extractPrefix("3 个方法"), null, "纯整数不算号");
    assert.equal(BN.extractPrefix("2.1版本"), null, "没有分隔空格不算号");
    // v0.7.7：`1【…】` 是树编号模板 1 的产出，认作章号（原来判 null）
    assert.deepEqual(BN.extractPrefix("1【试验设计与数据分析: 基于R语言】"), {value: "1", kind: "章"});
    assert.equal(BN.extractPrefix("About"), null, "纯文字不算号");
});

test("G33 纯数字节号下编号可收敛（幂等）", () => {
    const blocks = [B("a", 2, "顶一"), B("b", 3, "子一"), B("c", 2, "顶二")];
    const r1 = BN.buildBodyPlan({docTitle: "2.1 BBBBB", blocks: blocks, normalizeDepth: true});
    const after = applied(blocks, r1.plan);
    const r2 = BN.buildBodyPlan({docTitle: "2.1 BBBBB", blocks: after, normalizeDepth: true});
    assert.equal(r2.plan.length, 0, "第二遍零改动：" + JSON.stringify(r2.plan));
});

/* ---- v0.7.0 统一词表：fn（文档侧）/ hn（内容侧） ---- */
test("G34 {fn}/{hn} 词表：文档号与内容号可自由组合", () => {
    const ctx = {prefix: "2.1", n: "1", h1: "2.1.1", cn: "①", title: "取样",
                 fn: [, 2, 1], hn: [, 1, 1]};
    assert.equal(BN.renderBodyTemplate("{fn}.{hn1}", 1, ctx), "2.1.1");
    assert.equal(BN.renderBodyTemplate("{fn2}.{hn1}", 1, ctx), "1.1");
    assert.equal(BN.renderBodyTemplate("（{hn2}）", 2, ctx), "（1）");
    // v0.8.5：逐级拼出完整号 —— {fn1}.{fn2}.{hn1} = 2.1.1
    assert.equal(BN.renderBodyTemplate("{fn1}.{fn2}.{hn1}", 1, ctx), "2.1.1");
    assert.equal(BN.renderBodyTemplate("{hn1}.{hn2}", 2, ctx), "1.1");
    assert.equal(BN.renderBodyTemplate("{fn}-{hn}", 2, ctx), "2.1-1.1");
    // 缺级留空，不拼半截号
    assert.equal(BN.renderBodyTemplate("{fn3}", 1, ctx), "");
    assert.equal(BN.renderBodyTemplate("{hn4}", 1, ctx), "");
});

test("G35 旧写法与新写法等价（别名不破兼容）", () => {
    const ctx = {prefix: "2.1", n: "2", h1: "2.1.1", cn: "②", title: "处理",
                 fn: [, 2, 1], hn: [, 1, 2]};
    assert.equal(BN.renderBodyTemplate("{fn}", 2, ctx), BN.renderBodyTemplate("{prefix}", 2, ctx),
                 "{fn} 等价旧 {prefix}");
    assert.equal(BN.renderBodyTemplate("{hn2}", 2, ctx), "2", "{hn2} = 第 2 级单个序号");
    assert.equal(BN.renderBodyTemplate("{fn}.{n}", 2, ctx), "2.1.2", "{fn}+{n} 等价旧 prefix+n");
    assert.equal(BN.renderBodyTemplate("{h1}.{n}", 2, ctx), "2.1.1.2", "旧 h1 仍是已渲染的一级号");
});

test("G36 新写法的剥号正则：{fn} / {hnN} 都能剥，且不吞标题", () => {
    const re1 = BN.bodyStripRegex("{fn}.{hn1} {title}");
    assert.ok(re1.test("2.1.1 取样方法"));
    assert.ok(!re1.test("取样方法"), "没有号就不剥");
    const re2 = BN.bodyStripRegex("（{hn3}）");
    assert.ok(re2.test("（3）要点"));
    const blocks = [{id: "a", level: 1, markdown: "# 2.1.1 取样"}];
    const r = BN.buildBodyPlan({docTitle: "第2.1节 取样", blocks: blocks,
        formats: BN.normalizeBodyFormats({1: "{fn}.{hn1} {title}"})});
    assert.equal(r.plan.length, 0, "同号同形 → 幂等，不该产生改名项");
});

/* ---- v0.7.1 数字输出格式（内容侧） ---- */
test("G37 内容模板的数字格式：cn/CN/a/o/i/补零 与复合号逐段转换", () => {
    const ctx = {prefix: "2.1", n: "1", h1: "2.1.1", cn: "①", title: "要点",
                 fn: [, 2, 1], hn: [, 1, 1]};
    // v0.8.5：{hn3} 是第 3 级单个序号（1.1.3 → 3）
    assert.equal(BN.renderBodyTemplate("（{hn3:cn}）", 3, Object.assign({}, ctx, {hn: [, 1, 1, 3]}))
                 , "（三）");
    assert.equal(BN.renderBodyTemplate("（{n:cn}）", 3, Object.assign({}, ctx, {n: "3"})), "（三）");
    assert.equal(BN.renderBodyTemplate("（{n:cn}）", 3, Object.assign({}, ctx, {n: "11"})), "（十一）");
    assert.equal(BN.renderBodyTemplate("{hn1:CN}）", 1, ctx), "壹）");
    assert.equal(BN.renderBodyTemplate("{hn1:a})", 1, ctx), "a)");
    assert.equal(BN.renderBodyTemplate("{hn1:o}", 1, ctx), "①");
    assert.equal(BN.renderBodyTemplate("{fn:cn}.{hn1:cn}", 1, ctx), "二.一.一");
    assert.equal(BN.renderBodyTemplate("{fn:02}", 1, ctx), "02.01");
    assert.equal(BN.renderBodyTemplate("{prefix}.{n}", 1, ctx), "2.1.1", "不带格式 → 旧行为");
});

test("G38 带格式的旧号能剥掉且幂等（关键：否则一运行就叠号）", () => {
    const re = BN.bodyStripRegex("（{hn3:cn}）");
    assert.ok(re.test("（三）要点"), "中文圈号式能剥");
    assert.ok(!re.test("要点"), "没有号不剥");

    const blocks = [{id: "a", level: 1, markdown: "# 第一章 取样"}];
    const r = BN.buildBodyPlan({docTitle: "第2.1节 取样", blocks: blocks,
        formats: BN.normalizeBodyFormats({1: "第{fn1:cn}章 {title}"})});
    assert.equal(byId(r.plan, "a").to, "# 第二章 取样", "第一章 → 第二章，不是叠成两遍");
    const after = applied(blocks, r.plan);
    const r2 = BN.buildBodyPlan({docTitle: "第2.1节 取样", blocks: after,
        formats: BN.normalizeBodyFormats({1: "第{fn1:cn}章 {title}"})});
    assert.equal(r2.plan.length, 0, "第二遍零改动：" + JSON.stringify(r2.plan));
});

test("G39 复合号带格式：逐级拼接能剥得掉「02.01.01」", () => {
    const blocks = [{id: "a", level: 1, markdown: "# 02.01.01 取样"}];
    const r = BN.buildBodyPlan({docTitle: "第2.1节 取样", blocks: blocks,
        formats: BN.normalizeBodyFormats({1: "{fn1:02}.{fn2:02}.{hn1:02} {title}"})});
    assert.equal(r.plan.length, 0, "同号同形 → 幂等，不该叠号：" + JSON.stringify(r.plan));
});

/* ---- v0.7.3 空标题不再死循环（真机事故：#### 35.9.3） ---- */
test("G40 只有编号、没有文字的标题：不补尾随空格，第二遍零改动", () => {
    const blocks = [{id: "x", level: 4, markdown: "#### 35.9.3"}];
    const r1 = BN.buildBodyPlan({docTitle: "第35章 句型", blocks: blocks,
        formats: BN.normalizeBodyFormats({1: "{prefix}.{n}", 2: "{hn1}.{n}",
                                          3: "（{n}）", 4: "{hn2}.{n}"}),
        normalizeDepth: true});
    const to = (byId(r1.plan, "x") || {}).to;
    assert.ok(to === undefined || !/\s$/.test(to), "绝不以空格结尾：" + JSON.stringify(to));
    const after = applied(blocks, r1.plan);
    const r2 = BN.buildBodyPlan({docTitle: "第35章 句型", blocks: after,
        formats: BN.normalizeBodyFormats({1: "{prefix}.{n}", 2: "{hn1}.{n}",
                                          3: "（{n}）", 4: "{hn2}.{n}"}),
        normalizeDepth: true});
    assert.equal(r2.plan.length, 0, "第二遍零改动：" + JSON.stringify(r2.plan));
});

test("G41 只差尾随空格不算改动（思源存盘会吃掉行尾空格）", () => {
    const blocks = [{id: "y", level: 2, markdown: "## 2.1.1 取样  "}];   // 末尾两个空格
    const r = BN.buildBodyPlan({docTitle: "第2.1节 x", blocks: blocks,
        formats: BN.normalizeBodyFormats({1: "{prefix}.{n}", 2: "{hn1}.{n}",
                                          3: "（{n}）", 4: "{n}）", 5: "{cn}"}),
        normalizeDepth: true});
    assert.equal(r.plan.length, 0, "不该为了去空格而反复改写：" + JSON.stringify(r.plan));
});

/* ---- v0.7.4 剥掉标题自带的手写序号（《第35章 2025 经典句型》双层号） ---- */
test("G42 手写序号 1. / （1） / 1） / 1、 都被剥，编号取代它", () => {
    // 每条单独一篇文档 → 序号都从 1 起
    const cases = ["1. The data presentedd here", "15. are broadly consistent",
                   "（1）要点", "1）要点", "1、要点"];
    cases.forEach((src) => {
        const r = BN.buildBodyPlan({docTitle: "第35章 句型",
            blocks: [{id: "a", level: 3, markdown: "### " + src}], normalizeDepth: true});
        const to = (byId(r.plan, "a") || {}).to;
        assert.ok(to && to.indexOf("1. ") < 0 && to.indexOf("15. ") < 0
                  && to.indexOf("（1）") < 0 && to.indexOf("1）") < 0 && to.indexOf("1、") < 0,
                  "手写号没剥干净：" + src + " → " + to);
        assert.ok(/^### 35\.1 /.test(to), "编号形态不对：" + src + " → " + to);
    });
});

test("G43 手写号剥离不碰复合号与 4 位年份（1.1 / 35.9.3 / 2024.）", () => {
    // 直接测剥离函数本身：这些形态必须原样返回
    const keep = ["1.1 试验设计", "35.9.3", "2024. 年度总结", "1.5 试验",
                  "2024年度总结", "warrants further exploration"];
    keep.forEach((src) => assert.equal(BN.stripHandNumber(src), src, "不该剥：" + src));
    // 而 1.1 这种旧小节号仍由「按模板剥号」换成本篇新号（不是手写号剥离干的）
    const r = BN.buildBodyPlan({docTitle: "第35章 句型",
        blocks: [{id: "a", level: 1, markdown: "# 1.1 试验设计"}], normalizeDepth: true});
    assert.equal(byId(r.plan, "a").to, "# 35.1 试验设计", "旧小节号被换成本篇号");
});

test("G44 剥手写号后可收敛（幂等），且能清掉「1. 35.1 标题」历史叠号", () => {
    const fmt = BN.normalizeBodyFormats({1: "{prefix}.{n}"});
    const b1 = [{id: "a", level: 3, markdown: "### 1. The data"}];
    const r1 = BN.buildBodyPlan({docTitle: "第35章 句型", blocks: b1, formats: fmt, normalizeDepth: true});
    assert.equal(byId(r1.plan, "a").to, "### 35.1 The data");
    const after = applied(b1, r1.plan);
    const r2 = BN.buildBodyPlan({docTitle: "第35章 句型", blocks: after, formats: fmt, normalizeDepth: true});
    assert.equal(r2.plan.length, 0, "第二遍零改动：" + JSON.stringify(r2.plan));

    const dirty = [{id: "b", level: 3, markdown: "### 2. 35.2 be exacerbated"}];
    const r3 = BN.buildBodyPlan({docTitle: "第35章 句型", blocks: dirty, formats: fmt, normalizeDepth: true});
    assert.equal(byId(r3.plan, "b").to, "### 35.1 be exacerbated", "历史叠号一次清干净");
});

/* ---- v0.7.5 静态审查补的三条硬洞 ---- */
test("G45 残缺井号（###/##）不是标题，绝不改写（老实现会写出「### 35.1 ###」）", () => {
    ["###", "##", "#", "   ###", ""].forEach((md) => {
        const r = BN.buildBodyPlan({docTitle: "第35章 x",
            blocks: [{id: "a", level: 3, markdown: md}], normalizeDepth: true});
        assert.equal((r.plan || []).length, 0, "不该改写 " + JSON.stringify(md));
    });
    // 正常标题照常
    const ok = BN.buildBodyPlan({docTitle: "第35章 x",
        blocks: [{id: "a", level: 3, markdown: "### 正常"}], normalizeDepth: true});
    assert.equal(byId(ok.plan, "a").to, "### 35.1 正常");
});

test("G46 级别以内容井号数为准（SQL subtype 滞后不会把 H3 写回 H1）", () => {
    // 元数据说 h1，内容已是 h3 → 按 h3 输出，且 shift 也按 h3 算
    const r = BN.buildBodyPlan({docTitle: "第35章 x",
        blocks: [{id: "a", level: 1, markdown: "### 标题"}], normalizeDepth: true});
    assert.equal(r.depthShift, 2, "shift 必须按内容级别算");
    assert.equal(byId(r.plan, "a").to, "### 35.1 标题");
    // 反向：元数据 h3、内容是 h1
    const r2 = BN.buildBodyPlan({docTitle: "第35章 x",
        blocks: [{id: "a", level: 3, markdown: "# 标题"}], normalizeDepth: true});
    assert.equal(r2.depthShift, 0);
    assert.equal(byId(r2.plan, "a").to, "# 35.1 标题");
});

test("G47 shift 与模板选择口径一致：混合级别里元数据全错也不串级", () => {
    // 内容真实层级 h2 / h3 / h2，元数据全写 1
    const blocks = [{id: "a", level: 1, markdown: "## 甲"},
                    {id: "b", level: 1, markdown: "### 乙"},
                    {id: "c", level: 1, markdown: "## 丙"}];
    const r = BN.buildBodyPlan({docTitle: "第5.1节 取样", blocks: blocks, normalizeDepth: true});
    assert.equal(r.depthShift, 1, "最浅是 h2 → shift 1");
    assert.equal(byId(r.plan, "a").to, "## 5.1.1 甲");
    assert.equal(byId(r.plan, "b").to, "### 5.1.1.1 乙");
    assert.equal(byId(r.plan, "c").to, "## 5.1.2 丙");
});

test("G48 focus 转级仍生效（段落 → 指定级别标题）", () => {
    const blocks = [{id: "a", level: 0, markdown: "普通段落"},
                    {id: "b", level: 0, markdown: "另一段"}];
    const r = BN.buildBodyPlan({docTitle: "第5.1节 取样", blocks: blocks,
        focus: {id: "a", level: 2}, normalizeDepth: true});
    assert.equal(byId(r.plan, "a").to, "## 5.1.1 普通段落", "焦点块要被转成 H2");
    assert.equal(byId(r.plan, "b"), undefined, "非焦点段落不动");
});

/* ---- v0.7.7 前缀识别补树编号产出形态（03【 …】/【3】…/第N篇） ---- */
test("G49 认「03【 标题】」「【3】标题」「第3篇…」「第3部 …」这几种树编号产出", () => {
    assert.deepEqual(BN.extractPrefix("03【 主持或参与的主要科研项目】"), {value: "03", kind: "章"});
    assert.deepEqual(BN.extractPrefix("01【 个人简介】"), {value: "01", kind: "章"});
    assert.deepEqual(BN.extractPrefix("【3】Tidyverse教程"), {value: "3", kind: "章"});
    assert.deepEqual(BN.extractPrefix("第3篇导论"), {value: "3", kind: "章"});
    assert.deepEqual(BN.extractPrefix("第3部 上部"), {value: "3", kind: "章"});
});

test("G50 新形态下正文编号可用，且不误伤既有判据", () => {
    const r = BN.buildBodyPlan({docTitle: "03【 主持或参与的主要科研项目】",
        blocks: [{id: "a", level: 1, markdown: "# 项目一"},
                 {id: "b", level: 1, markdown: "# 项目二"}], normalizeDepth: true});
    assert.equal(r.prefix, "03");
    assert.equal(byId(r.plan, "a").to, "# 03.1 项目一");
    assert.equal(byId(r.plan, "b").to, "# 03.2 项目二");
    // 仍然不认这些
    assert.equal(BN.extractPrefix("2024 年度总结"), null);
    assert.equal(BN.extractPrefix("3 个方法"), null);
    assert.equal(BN.extractPrefix("About"), null);
    // 根文档 `1【…】` 也认（tree 模板 1 的形态），编号成 1.x；它有没有正文标题由内容决定
    assert.deepEqual(BN.extractPrefix("1【试验设计与数据分析: 基于R语言】"), {value: "1", kind: "章"});
});

/* ---- v0.8.0 属性编号优先（模板怎么变都无所谓） ---- */
test("G51 有属性号时用属性，标题文字完全不管", () => {
    const blocks = [{id: "a", level: 2, markdown: "## 甲"}];
    const r = BN.buildBodyPlan({docTitle: "随便什么标题（没有任何号）", docNum: "3.1",
        docNumPad: 0, blocks: blocks, normalizeDepth: true});
    assert.equal(r.prefix, "3.1");
    assert.equal(r.prefixKind, "attr");
    assert.equal(byId(r.plan, "a").to, "## 3.1.1 甲");
});

test("G52 属性补零只补本级（第1级 {nn} → 03；第2级 1.3 → 1.03）", () => {
    const blocks = [{id: "a", level: 1, markdown: "# 甲"}];
    const r1 = BN.buildBodyPlan({docTitle: "x", docNum: "3", docNumPad: 2,
        blocks: blocks, normalizeDepth: true});
    assert.equal(r1.prefix, "03");
    assert.equal(byId(r1.plan, "a").to, "# 03.1 甲");
    const r2 = BN.buildBodyPlan({docTitle: "x", docNum: "1.3", docNumPad: 2,
        blocks: blocks, normalizeDepth: true});
    assert.equal(r2.prefix, "1.03", "父级 1 不该补零");
});

test("G53 没有属性时回退标题识别（老文档不断档）", () => {
    const blocks = [{id: "a", level: 1, markdown: "# 甲"}];
    const r = BN.buildBodyPlan({docTitle: "第5章 试验设计", blocks: blocks, normalizeDepth: true});
    assert.equal(r.prefix, "5");
    assert.equal(r.prefixKind, "章");
    const r2 = BN.buildBodyPlan({docTitle: "03【 其他材料】", blocks: blocks, normalizeDepth: true});
    assert.equal(r2.prefix, "03", "也回退到 03");
});

/* ---- v0.8.1 {h1} 必须是纯号（否则二级标题每轮加一段 .1，越来越长） ---- */
test("G54 第1级模板带装饰（[{n}] ）时，{h1} 仍是纯号，不累积", () => {
    const F = {1: "[{n}] ", 2: "{h1}.{n}", 3: "（{n}）", 4: "{n}）", 5: "{cn}"};
    const blocks = [
        {id: "a", level: 4, markdown: "#### [1] 学院个人主页"},
        {id: "b", level: 4, markdown: "#### [2] 简介"},
        {id: "c", level: 5, markdown: "##### [2] .1 .1 .1 .1 辽宁省水利学会"},
    ];
    const r = BN.buildBodyPlan({docTitle: "01【 个人简介】", docNum: "1", docNumPad: 2,
        blocks: blocks, formats: BN.normalizeBodyFormats(F), normalizeDepth: true});
    assert.equal(byId(r.plan, "c").to, "##### 2.1 辽宁省水利学会", "模板1 不含 prefix → {h1}=序号 2");
    // 幂等：再跑不再加 .1
    const after = blocks.map((b) => {
        const p = r.plan.find((x) => x.id === b.id);
        return p ? {id: b.id, level: b.level, markdown: p.to} : b;
    });
    const r2 = BN.buildBodyPlan({docTitle: "01【 个人简介】", docNum: "1", docNumPad: 2,
        blocks: after, formats: BN.normalizeBodyFormats(F), normalizeDepth: true});
    assert.equal(r2.plan.length, 0, "第二遍零改动：" + JSON.stringify(r2.plan.map((x) => x.to)));
});

test("G55 行首「.1 .1 … / ..2 2」这类碎渣全部剥掉", () => {
    assert.equal(BN.stripNumber(".1 .1 .1 辽宁省"), "辽宁省");
    /* v0.8.4：以「.数字」开头的标题不可能是正文 —— 一律剥掉，否则各代模板剥的长度不同，
     * 每轮算出不同结果、越改越乱。`.5 小时` 会变「小时」，这个取舍是故意的。 */
    assert.equal(BN.stripNumber(".5 小时"), "小时");
    assert.equal(BN.stripNumber(".1 标题"), "标题");
    // 「.N N」重复数字对（真机 `..2 2 主要功能`）
    assert.equal(BN.stripNumber("..2 2 主要功能"), "主要功能");
    assert.equal(BN.stripNumber("..11 11 许可"), "许可");
    assert.equal(BN.stripNumber("3 个方法"), "3 个方法", "没有点、不是编号形态 → 不动");
});
