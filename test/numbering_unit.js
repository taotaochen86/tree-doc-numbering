/* 编号核心离线单测：node test/numbering_unit.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../src/numbering.js");

function nd(id, title, children, order) {
    return {id, title, children: children || [], order: order || null};
}

function sampleTree() {
    return nd("root", "书稿", [
        nd("buA", "绪论", [
            nd("zhA1", "研究背景", [
                nd("jiA1a", "国内外现状", [nd("l4", "第四层不编号", [])]),
                nd("jiA1b", "问题提出"),
            ]),
            nd("zhA2", "研究内容"),
        ]),
        nd("buB", "材料与方法", [
            nd("zhB1", "试验地概况"),
            nd("zhB2", "测定方法"),
        ]),
    ]);
}

function byId(plan, id) {
    return plan.find((p) => p.id === id);
}

function applyPlan(tree, plan) {
    const map = new Map(plan.map((p) => [p.id, p.to]));
    (function walk(n) {
        if (map.has(n.id)) n.title = map.get(n.id);
        (n.children || []).forEach(walk);
    })(tree);
    return tree;
}

test("A1 三层编号：部/章/节标签正确", () => {
    const p = N.buildPlan(sampleTree());
    assert.equal(byId(p, "buA").to, "第01部 绪论");
    assert.equal(byId(p, "buB").to, "第02部 材料与方法");
    assert.equal(byId(p, "zhA1").to, "第01章 研究背景");
    assert.equal(byId(p, "zhA2").to, "第02章 研究内容");
    assert.equal(byId(p, "jiA1a").to, "第01节 国内外现状");
    assert.equal(byId(p, "jiA1b").to, "第02节 问题提出");
});

test("A2 章号全书连续：第02部下不再从第01章开始", () => {
    const p = N.buildPlan(sampleTree());
    assert.equal(byId(p, "zhA1").to, "第01章 研究背景");
    assert.equal(byId(p, "zhA2").to, "第02章 研究内容");
    assert.equal(byId(p, "zhB1").to, "第03章 试验地概况");
    assert.equal(byId(p, "zhB2").to, "第04章 测定方法");
});

test("A16 部/章全书连续，节仍按章各自从 01 重排", () => {
    // 2 部 × 每部 2 章 × 每章 2 节
    const tree = nd("r", "书", [
        nd("b1", "第一部", [
            nd("c1", "章一", [nd("s1", "节1"), nd("s2", "节2")]),
            nd("c2", "章二", [nd("s3", "节3"), nd("s4", "节4")]),
        ]),
        nd("b2", "第二部", [
            nd("c3", "章三", [nd("s5", "节5"), nd("s6", "节6")]),
            nd("c4", "章四", [nd("s7", "节7"), nd("s8", "节8")]),
        ]),
    ]);
    const p = N.buildPlan(tree);
    assert.deepEqual([1, 2].map((i) => byId(p, "b" + i).to),
        ["第01部 第一部", "第02部 第二部"]);
    assert.deepEqual([1, 2, 3, 4].map((i) => byId(p, "c" + i).to),
        ["第01章 章一", "第02章 章二", "第03章 章三", "第04章 章四"]);
    for (let c = 1; c <= 4; c++) {
        const first = "s" + (2 * c - 1), second = "s" + (2 * c);
        assert.equal(byId(p, first).to, "第01节 " + byId(p, first).from);
        assert.equal(byId(p, second).to, "第02节 " + byId(p, second).from);
    }
    // 连续跑两遍仍幂等
    applyPlan(tree, p);
    assert.deepEqual(N.buildPlan(tree), []);
});

test("A3 第四层及更深原样不动", () => {
    const p = N.buildPlan(sampleTree());
    assert.equal(byId(p, "l4"), undefined);
    assert.equal(p.length, 8);   // 2 部 + 4 章 + 2 节
});

test("A4 连续跑两遍幂等：第二遍没有待改项", () => {
    const tree = sampleTree();
    const p1 = N.buildPlan(tree);
    applyPlan(tree, p1);
    const p2 = N.buildPlan(tree);
    assert.deepEqual(p2, []);
});

test("A5 历史叠加编号被一次剥干净", () => {
    assert.equal(N.stripPrefix("第01部 第01部 绪论"), "绪论");
    assert.equal(N.stripPrefix("第02章 第03节 方法"), "方法");
    const tree = nd("r", "书", [nd("x", "第01部 第01部 绪论")]);
    assert.equal(N.buildPlan(tree)[0].to, "第01部 绪论");
});

test("A6 切换编号前先剔老号：第N章 会被剔，中文序号与 1.1 保留", () => {
    /* v0.8.2 口径变更：`第1章 …` 属于「显式编号形态」，编号前一律剔除（用户要求
     * 「切换编号前，应该自动剔除老编号」）。中文序号「第一章」与复合号「1.1」不是
     * 本插件任何一代模板的产出形态，仍按正文保留。 */
    const tree = nd("r", "书", [
        nd("a", "第1章 绪论"),
        nd("b", "第一章 方法"),
        nd("c", "1.1 结果"),
        nd("d", "第01章 讨论"),
    ]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "a").to, "第01部 绪论");
    assert.equal(byId(p, "b").to, "第02部 第一章 方法");
    assert.equal(byId(p, "c").to, "第03部 1.1 结果");
    assert.equal(byId(p, "d").to, "第04部 讨论");
});

test("A7 超过 99 自然变 3 位，不截断", () => {
    const kids = [];
    for (let i = 1; i <= 100; i++) kids.push(nd("d" + i, "标题" + i));
    const p = N.buildPlan(nd("r", "书", kids));
    assert.equal(byId(p, "d1").to, "第01部 标题1");
    assert.equal(byId(p, "d99").to, "第99部 标题99");
    assert.equal(byId(p, "d100").to, "第100部 标题100");
});

test("A8 空树 / 空标题 / 只有编号的标题不生成改名项", () => {
    assert.deepEqual(N.buildPlan(nd("r", "书", [])), []);
    const p = N.buildPlan(nd("r", "书", [nd("x", "第01部 "), nd("y", ""), nd("z", "正常")]));
    assert.equal(byId(p, "x"), undefined);
    assert.equal(byId(p, "y"), undefined);
    assert.equal(byId(p, "z").to, "第01部 正常");
});

test("A9 Syncthing 冲突副本不参与编号、也不占号", () => {
    const tree = nd("r", "书", [
        nd("a", "绪论"),
        nd("bad", "绪论 (Conflicted copy 2026-11-07)"),
        nd("b", "方法"),
    ]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "bad"), undefined);
    assert.equal(byId(p, "b").to, "第02部 方法");
});

test("A10 层级变了：旧「章」前缀换成「部」，不叠加", () => {
    const tree = nd("r", "书", [nd("x", "第01章 研究背景")]);
    assert.equal(N.buildPlan(tree)[0].to, "第01部 研究背景");
});

test("A11 orderChildren 照搬 listDocsByPath 的真实顺序，不按标题排序", () => {
    const kids = [nd("a", "甲"), nd("b", "乙"), nd("c", "丙")];
    const ordered = N.orderChildren(kids, ["c", "a", "b"]);
    assert.deepEqual(ordered.map((n) => n.id), ["c", "a", "b"]);
    const tree = nd("r", "书", kids, ["c", "a", "b"]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "c").to, "第01部 丙");
    assert.equal(byId(p, "a").to, "第02部 甲");
    assert.equal(byId(p, "b").to, "第03部 乙");
});

test("A12 buildTreeFromRows 用 ID 路径建父子（父段不带 .sy）", () => {
    const rootInfo = {id: "R", content: "书", path: "/R.sy"};
    const rows = [
        {id: "A", content: "绪论", path: "/R/A.sy"},
        {id: "A1", content: "背景", path: "/R/A/A1.sy"},
        {id: "A1a", content: "现状", path: "/R/A/A1/A1a.sy"},
        {id: "L4", content: "第四层", path: "/R/A/A1/A1a/L4.sy"},
        {id: "BAD", content: "绪论 (Conflicted copy)", path: "/R/BAD.sy"},
        {id: "B", content: "方法", path: "/R/B.sy"},
    ];
    const tree = N.buildTreeFromRows(rootInfo, rows);
    assert.deepEqual(tree.children.map((n) => n.id), ["A", "B"]);
    assert.deepEqual(tree.children[0].children.map((n) => n.id), ["A1"]);
    assert.deepEqual(tree.children[0].children[0].children.map((n) => n.id), ["A1a"]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "A").to, "第01部 绪论");
    assert.equal(byId(p, "B").to, "第02部 方法");
    assert.equal(byId(p, "A1").to, "第01章 背景");
    assert.equal(byId(p, "A1a").to, "第01节 现状");
    assert.equal(byId(p, "L4"), undefined);
    assert.equal(byId(p, "BAD"), undefined);
});

test("A13 applyOrderTree + nodesNeedingOrder：叶子不调顺序接口", () => {
    const tree = N.buildTreeFromRows(
        {id: "R", content: "书", path: "/R.sy"},
        [
            {id: "A", content: "绪论", path: "/R/A.sy"},
            {id: "A1", content: "背景", path: "/R/A/A1.sy"},
            {id: "B", content: "方法", path: "/R/B.sy"},
        ]
    );
    N.applyOrderTree(tree, {"/R": ["B", "A"], "/R/B": [], "/R/A": ["A1"]});
    assert.deepEqual(N.nodesNeedingOrder(tree).map((n) => n.id), ["R", "A"]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "B").to, "第01部 方法");
    assert.equal(byId(p, "A").to, "第02部 绪论");
});

test("A15 applyNames：用文档树实时标题覆盖滞后的 SQL 标题", () => {
    const tree = N.buildTreeFromRows(
        {id: "R", content: "书", path: "/R.sy"},
        [
            {id: "A", content: "第01部 绪论（旧）", path: "/R/A.sy"},
            {id: "A1", content: "第01章 背景（旧）", path: "/R/A/A1.sy"},
        ]
    );
    N.applyNames(tree, {R: "书", A: "绪论", A1: "背景"});
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "A").to, "第01部 绪论");
    assert.equal(byId(p, "A1").to, "第01章 背景");
});

test("A14 makeTitle / stripPrefix 基本性质", () => {
    assert.equal(N.makeTitle(1, 3, "绪论"), "第03部 绪论");
    assert.equal(N.makeTitle(2, 12, "方法"), "第12章 方法");
    assert.equal(N.makeTitle(3, 1, "结果"), "第01节 结果");
    assert.equal(N.stripPrefix("绪论"), "绪论");
    assert.equal(N.stripPrefix("第1章 绪论"), "第1章 绪论");
    assert.equal(N.stripPrefix("第一章 绪论"), "第一章 绪论");
    assert.equal(N.stripPrefix("第01部绪论"), "第01部绪论");  // 没空格不算插件前缀
});

/* ===== v0.2.0：自动编号 / 多级自定义排序 / 占位标题 ===== */

const FILES = [
    {id: "d1", name: "第一章原始名", path: "/R/d1.sy", sort: 3, subFileCount: 2},
    {id: "d2", name: "无标题", path: "/R/d2.sy", sort: 1, subFileCount: 0},
    {id: "d3", name: "方法与材料", path: "/R/d3.sy", sort: 2, subFileCount: 0},
];

test("B1 childrenFromFiles：files 数组次序=自定义排序，name=实时标题，subFileCount 标出子层", () => {
    const made = N.childrenFromFiles("/R.sy", FILES);
    assert.deepEqual(made.order, ["d1", "d2", "d3"]);   // 不按 sort 数值，也不按名字，照树里的顺序
    assert.equal(made.children[0].title, "第一章原始名");
    assert.equal(made.children[0].subFileCount, 2);
    assert.equal(made.children[1].subFileCount, 0);
    assert.equal(made.children[2].path, "/R/d3.sy");
});

test("B2 pathForList：文档用 ID 路径去 .sy，笔记本根用 /", () => {
    assert.equal(N.pathForList("/R/A.sy"), "/R/A");
    assert.equal(N.pathForList("/.sy"), "/");
    assert.equal(N.pathForList(""), "/");
});

test("B3 多级自定义排序：部/章/节每一级各自按自己的 order 数组", () => {
    const root = nd("R", "书", [
        nd("bA", "甲部", [nd("cA1", "章一"), nd("cA2", "章二")], null),
        nd("bB", "乙部", [nd("cB1", "章三"), nd("cB2", "章四")], ["cB2", "cB1"]),
        nd("bC", "丙部", [], null),
    ], ["bC", "bA", "bB"]);
    const p = N.buildPlan(root);
    assert.equal(byId(p, "bC").to, "第01部 丙部");
    assert.equal(byId(p, "bA").to, "第02部 甲部");
    assert.equal(byId(p, "bB").to, "第03部 乙部");
    // 章全书连号，但乙部内部按它自己的自定义顺序
    assert.equal(byId(p, "cA1").to, "第01章 章一");
    assert.equal(byId(p, "cA2").to, "第02章 章二");
    assert.equal(byId(p, "cB2").to, "第03章 章四");
    assert.equal(byId(p, "cB1").to, "第04章 章三");
});

test("B4 fingerprint：顺序变、标题变都要变；同一棵树稳定", () => {
    const a = nd("R", "书", [nd("x", "甲"), nd("y", "乙")], ["x", "y"]);
    const b = nd("R", "书", [nd("x", "甲"), nd("y", "乙")], ["y", "x"]);
    assert.equal(N.fingerprint(a), N.fingerprint(nd("R", "书", [nd("x", "甲"), nd("y", "乙")], ["x", "y"])));
    assert.notEqual(N.fingerprint(a), N.fingerprint(b), "拖动顺序必须改变指纹");
    const c = nd("R", "书", [nd("x", "甲改名"), nd("y", "乙")], ["x", "y"]);
    assert.notEqual(N.fingerprint(a), N.fingerprint(c), "改名必须改变指纹");
});

test("B5 isStructuralCmd：只认结构事件，打字产生的一律不触发", () => {
    ["create", "removeDoc", "rename", "filetreeSortChanged", "moveDoc"].forEach((c) =>
        assert.equal(N.isStructuralCmd(c), true, c));
    ["savedoc", "transactions", "databaseIndexCommit", "syncPending", "statusbar", "backgroundtask", ""]
        .forEach((c) => assert.equal(N.isStructuralCmd(c), false, c));
});

test("B6 isPlaceholder：思源新建文档的占位标题", () => {
    ["", "无标题", "Untitled", "untitled", "未命名", "新建文档", "Untitled 3", "  "].forEach((s) =>
        assert.equal(N.isPlaceholder(s), true, JSON.stringify(s)));
    ["绪论", "第01部 绪论", "1.1 背景"].forEach((s) => assert.equal(N.isPlaceholder(s), false, s));
});

test("B7 占位标题不编号也不占号；关掉开关后照常编号", () => {
    const tree = nd("R", "书", [nd("a", "绪论"), nd("b", "无标题"), nd("c", "方法")]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "a").to, "第01部 绪论");
    assert.equal(byId(p, "c").to, "第02部 方法");
    assert.equal(byId(p, "b"), undefined, "占位文档不该被改名");
    const p2 = N.buildPlan(tree, {skipPlaceholder: false});
    assert.equal(byId(p2, "b").to, "第02部 无标题");
    assert.equal(byId(p2, "c").to, "第03部 方法");
});

test("B8 orderFromSortEvent：拖动事件自带新顺序", () => {
    assert.deepEqual(N.orderFromSortEvent({parentPath: "/R/A", childIDs: ["c2", "c1"]}),
        {parentPath: "/R/A", ids: ["c2", "c1"]});
    assert.equal(N.orderFromSortEvent({parentPath: "/", childIDs: []}), null);
    assert.equal(N.orderFromSortEvent(null), null);
});

test("B9 拖动后整棵树重排：旧前缀先剥掉，再按新顺序连号", () => {
    const tree = nd("R", "书", [nd("a", "甲"), nd("b", "乙"), nd("c", "丙")], ["a", "b", "c"]);
    applyPlan(tree, N.buildPlan(tree));
    assert.equal(tree.children[0].title, "第01部 甲");
    tree.order = ["c", "a", "b"];                       // 用户把「丙」拖到最前
    applyPlan(tree, N.buildPlan(tree));
    assert.deepEqual(tree.order.map((id) => tree.children.find((n) => n.id === id).title),
        ["第01部 丙", "第02部 甲", "第03部 乙"]);
    assert.ok(tree.children.every((n) => !/第\d+部 第\d+部/.test(n.title)), "不能叠加前缀");
});

test("B10 笔记本虚拟根：/.sy 展开成根级文档，照样三级连号", () => {
    const root = {id: "__notebook__box", title: "笔记本", path: "/.sy", children: [], order: null};
    const made = N.childrenFromFiles(root.path, [
        {id: "b1", name: "上部", path: "/b1.sy", subFileCount: 1},
        {id: "b2", name: "下部", path: "/b2.sy", subFileCount: 0},
    ]);
    root.children = made.children;
    root.order = made.order;
    root.children[0].children = [nd("c1", "第一章")];
    const p = N.buildPlan(root);
    assert.equal(byId(p, "b1").to, "第01部 上部");
    assert.equal(byId(p, "b2").to, "第02部 下部");
    assert.equal(byId(p, "c1").to, "第01章 第一章");
});

/* ===== 排除部分文档不编号 ===== */

function excludedTree() {
    return nd("R", "书", [
        nd("a", "第01部 甲"),
        nd("b", "第02部 附录", [nd("b1", "第01章 附一"), nd("b2", "第02章 附二")]),
        nd("c", "第03部 丙"),
    ]);
}

test("B11 排除单篇：剥掉自身编号、不占号；子文档照常编号", () => {
    const tree = excludedTree();
    const p = N.buildPlan(tree, {skipIds: ["b"]});
    assert.equal(byId(p, "b").to, "附录");
    assert.equal(byId(p, "b").reason, "excluded");
    applyPlan(tree, p);
    assert.equal(tree.children[0].title, "第01部 甲");
    assert.equal(tree.children[1].title, "附录");
    assert.equal(tree.children[2].title, "第02部 丙", "排除项不占号，后面的部要补位");
    assert.equal(tree.children[1].children[0].title, "第01章 附一");
    assert.equal(tree.children[1].children[1].title, "第02章 附二");
});

test("B12 排除整支：自身与子文档都剥掉编号、都不占号", () => {
    const tree = excludedTree();
    const p = N.buildPlan(tree, {skipSubtreeIds: ["b"]});
    assert.equal(byId(p, "b1").reason, "excluded", "整支里的子文档只剥前缀、不参与编号");
    assert.equal(byId(p, "b1").level, 0, "剥前缀项不算层级编号");
    applyPlan(tree, p);
    assert.equal(tree.children[1].title, "附录");
    assert.equal(tree.children[1].children[0].title, "附一");
    assert.equal(tree.children[1].children[1].title, "附二");
    assert.equal(tree.children[2].title, "第02部 丙");
});

test("B13 取消排除：重新纳入编号，不叠加前缀", () => {
    const tree = excludedTree();
    applyPlan(tree, N.buildPlan(tree, {skipSubtreeIds: ["b"]}));
    applyPlan(tree, N.buildPlan(tree));
    assert.equal(tree.children[1].title, "第02部 附录");
    assert.equal(tree.children[1].children[0].title, "第01章 附一");
    assert.equal(tree.children[1].children[1].title, "第02章 附二");
    assert.equal(tree.children[2].title, "第03部 丙");
    assert.ok(!/第\d+部 第\d+部/.test(tree.children[1].title));
});

/* ============ C 系列：Q9 三级格式模板自定义 ============ */
const F_EN = {1: "Chapter {nn} - {title}", 2: "§{n} {title}", 3: "{nn}. {title}"};

test("C1 内置默认模板输出与旧版硬编码逐字一致", () => {
    const F = N.normalizeFormats(null);
    assert.equal(N.renderTemplate(F[1], 1, 1, "绪论"), "第01部 绪论");
    assert.equal(N.renderTemplate(F[2], 2, 12, "方法"), "第12章 方法");
    assert.equal(N.renderTemplate(F[3], 3, 3, "结果"), "第03节 结果");
    assert.equal(N.makeTitle(1, 3, "绪论", F), N.makeTitle(1, 3, "绪论"));
});

test("C2 占位符 {nn}/{n}/{title} 与未知占位符", () => {
    assert.equal(N.renderTemplate("{nn} / {n} / {title} / {x}", 1, 3, "绪论"), "03 / 3 / 绪论 / {x}");
    assert.equal(N.renderTemplate("第{nn}部", 1, 7, "甲"), "第07部 甲");   // 缺 {title} 自动补
    assert.equal(N.renderTemplate("{title}：{title}", 1, 2, "甲"), "甲：甲");
});

test("C3 空模板回退内置；缺 {title} 补在末尾，绝不丢原标题", () => {
    assert.equal(N.normalizeTemplate("   ", 2), N.DEFAULT_FORMATS[2]);
    assert.equal(N.normalizeTemplate(null, 2), N.DEFAULT_FORMATS[2]);
    assert.equal(N.normalizeTemplate("Chapter {nn}", 1), "Chapter {nn} {title}");
    assert.ok(N.renderTemplate("", 1, 1, "绪论").endsWith("绪论"));
});

test("C4 原标题含 {n} 字样不会被二次解析", () => {
    const s = N.renderTemplate("第{nn}部 {title}", 1, 3, "含{n}和{nn}字样");
    assert.equal(s, "第03部 含{n}和{nn}字样");
});

test("C5 序号 100 不截断", () => {
    assert.equal(N.renderTemplate("第{nn}部 {title}", 1, 100, "附录"), "第100部 附录");
});

test("C6 stripByFormats 能剥自定义前缀与内置前缀", () => {
    assert.equal(N.stripByFormats("Chapter 01 - 绪论", [F_EN]), "绪论");
    assert.equal(N.stripByFormats("§3 方法", [F_EN]), "方法");
    assert.equal(N.stripByFormats("03. 结果", [F_EN]), "结果");
    assert.equal(N.stripByFormats("第01部 绪论", [F_EN]), "绪论");   // 内置兜底恒定在列
});

test("C7 切换编号时「第N章」被剥，「第一章」「第01章」各自按规则处理", () => {
    // v0.8.2：显式编号形态（第N章）一律剔除；中文序号不属任何一代模板，保留
    assert.equal(N.stripByFormats("第1章 绪论", [F_EN]), "绪论");
    assert.equal(N.stripByFormats("第一章 绪论", [F_EN]), "第一章 绪论");
    // stripPrefix 是历史入口，行为不变（只认 \d{2,} 的严格形态）
    assert.equal(N.stripPrefix("第1章 绪论"), "第1章 绪论");
    assert.equal(N.stripPrefix("第01章 绪论"), "绪论");
});

test("C8 换格式不叠前缀：内置 → 英文 → 再换回内置", () => {
    const tree = sampleTree();
    applyPlan(tree, N.buildPlan(tree));
    assert.equal(tree.children[0].title, "第01部 绪论");

    const opt = {formats: F_EN, stripFormats: [F_EN]};
    applyPlan(tree, N.buildPlan(tree, opt));
    assert.equal(tree.children[0].title, "Chapter 01 - 绪论");
    assert.equal(tree.children[0].children[0].title, "§1 研究背景");
    assert.equal(tree.children[0].children[0].children[0].title, "01. 国内外现状");

    // 换回内置：要能剥掉英文前缀，否则会叠成「第01部 Chapter 01 - 绪论」
    const back = {formats: N.normalizeFormats(null), stripFormats: [F_EN]};
    applyPlan(tree, N.buildPlan(tree, back));
    assert.equal(tree.children[0].title, "第01部 绪论");
    assert.equal(tree.children[0].children[0].title, "第01章 研究背景");
    assert.ok(!/Chapter/.test(tree.children[0].title));
});

test("C9 模板含正则元字符：转义后照样生成与剥离", () => {
    const F = {1: "({nn}) {title}", 2: "[{n}] {title}", 3: "{nn}. {title}"};
    assert.equal(N.renderTemplate(F[1], 1, 2, "甲"), "(02) 甲");
    assert.equal(N.stripByFormats("(02) 甲", [F]), "甲");
    assert.equal(N.stripByFormats("[3] 乙", [F]), "乙");
});

test("C10 后缀式模板：{title} 不在末尾也能渲染、也能剥旧前缀", () => {
    const F = {1: "{title}（第{nn}部）", 2: "{title}（第{nn}章）", 3: "{title}（第{nn}节）"};
    assert.equal(N.renderTemplate(F[1], 1, 1, "绪论"), "绪论（第01部）");
    assert.equal(N.stripByFormats("绪论（第01部）", [F]), "绪论");
    const tree = nd("root", "书稿", [nd("b1", "甲"), nd("b2", "乙")]);
    const p = N.buildPlan(tree, {formats: F, stripFormats: [F]});
    assert.equal(byId(p, "b1").to, "甲（第01部）");
    assert.equal(byId(p, "b2").to, "乙（第02部）");
    applyPlan(tree, p);
    assert.equal(N.buildPlan(tree, {formats: F, stripFormats: [F]}).length, 0, "幂等");
});

test("C11 buildPlan 用自定义格式，计数口径（部/章连续、节按章重排）不变", () => {
    const p = N.buildPlan(sampleTree(), {formats: F_EN, stripFormats: [F_EN]});
    assert.equal(byId(p, "buA").to, "Chapter 01 - 绪论");
    assert.equal(byId(p, "buB").to, "Chapter 02 - 材料与方法");
    assert.equal(byId(p, "zhA1").to, "§1 研究背景");
    assert.equal(byId(p, "zhB1").to, "§3 试验地概况");   // 章全书连号，不回 1
    assert.equal(byId(p, "jiA1a").to, "01. 国内外现状");
    assert.equal(byId(p, "jiA1b").to, "02. 问题提出");
    assert.equal(byId(p, "l4"), undefined, "第四层仍不编号");
});

test("C12 两套不同格式作用在同一棵树 → 两套不同标题（每范围各一套）", () => {
    const t1 = sampleTree(), t2 = sampleTree();
    applyPlan(t1, N.buildPlan(t1));
    applyPlan(t2, N.buildPlan(t2, {formats: F_EN, stripFormats: [F_EN]}));
    assert.equal(t1.children[0].title, "第01部 绪论");
    assert.equal(t2.children[0].title, "Chapter 01 - 绪论");
    assert.equal(t1.children[0].children[0].title, "第01章 研究背景");
    assert.equal(t2.children[0].children[0].title, "§1 研究背景");
});

test("C13 自定义格式下排除文档仍剥前缀、不占号", () => {
    const tree = excludedTree();
    const opt = {formats: F_EN, stripFormats: [F_EN], skipSubtreeIds: ["b"]};
    const p = N.buildPlan(tree, opt);
    assert.equal(byId(p, "c").to, "Chapter 02 - 丙", "整支排除不占号，后面的部仍是 02");
    assert.equal(byId(p, "b").to, "附录", "排除项剥掉旧前缀");
    assert.equal(byId(p, "b1").to, "附一");
});

test("C14 同格式重复跑幂等，不反复写库", () => {
    const tree = sampleTree();
    const opt = {formats: F_EN, stripFormats: [F_EN]};
    applyPlan(tree, N.buildPlan(tree, opt));
    assert.equal(N.buildPlan(tree, opt).length, 0);
});

test("C15 历史叠加前缀（8 层内）能剥干净", () => {
    const s = "Chapter 01 - Chapter 02 - 第03部 绪论";
    assert.equal(N.stripByFormats(s, [F_EN]), "绪论");
});

/* ============ D 系列：跳过「无命名文档」等占位标题 ============ */
test("D1 新增占位词全部识别（含带序号的变体）", () => {
    ["无命名文档", "无命名", "未命名文档", "未命名", "无标题", "Untitled",
     "untitled", "无标题 2", "未命名文档3", "Untitled 4", "新建文档"].forEach((s) => {
        assert.equal(N.isPlaceholder(s), true, s);
    });
});

test("D2 真实标题不被误判成占位", () => {
    ["未命名文档的整理思路", "无标题章节小结", "绪论", "第01部 绪论"].forEach((s) => {
        assert.equal(N.isPlaceholder(s), false, s);
    });
});

test("D3 占位文档不编号、不占号；后面的部号不被挤走", () => {
    const tree = nd("root", "书稿", [
        nd("b1", "甲"), nd("ph", "无命名文档"), nd("b2", "乙"),
    ]);
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "ph"), undefined);
    assert.equal(byId(p, "b1").to, "第01部 甲");
    assert.equal(byId(p, "b2").to, "第02部 乙");
});

test("D4 已带编号前缀的占位文档：剥掉旧号，不留在跳过项上", () => {
    const tree = nd("root", "书稿", [
        nd("b1", "第01部 甲"), nd("ph", "第02部 未命名文档"), nd("b2", "第03部 乙"),
    ]);
    const p = N.buildPlan(tree);
    const ph = byId(p, "ph");
    assert.equal(ph.to, "未命名文档");
    assert.equal(ph.reason, "placeholder");
    assert.equal(byId(p, "b2").to, "第02部 乙", "占位不占号，乙从第03部补到第02部");
    applyPlan(tree, p);
    assert.equal(tree.children[1].title, "未命名文档");
    assert.equal(tree.children[2].title, "第02部 乙");
});

test("D5 占位文档改好名字后自动补号", () => {
    const tree = nd("root", "书稿", [nd("b1", "甲"), nd("ph", "无命名文档"), nd("b2", "乙")]);
    applyPlan(tree, N.buildPlan(tree));
    tree.children[1].title = "真正的方法";           // 模拟用户在界面改标题
    const p = N.buildPlan(tree);
    assert.equal(byId(p, "ph").to, "第02部 真正的方法");
    assert.equal(byId(p, "b2").to, "第03部 乙");
});

test("D6 关掉「跳过占位」开关后，占位标题照常编号", () => {
    const tree = nd("root", "书稿", [nd("ph", "无命名文档")]);
    const p = N.buildPlan(tree, {skipPlaceholder: false});
    assert.equal(byId(p, "ph").to, "第01部 无命名文档");
});

/* ============ E 系列：层级数 1~5 + 每级计数方式 ============ */
function deepTree() {
    return nd("root", "书稿", [
        nd("b1", "部A", [
            nd("c1", "章A1", [
                nd("s1", "节A1a", [
                    nd("l4", "条A1", [nd("l5", "款A1")]),
                    nd("l4b", "条A2"),
                ]),
                nd("s2", "节A1b"),
            ]),
            nd("c2", "章A2"),
        ]),
        nd("b2", "部B", [
            nd("c3", "章B1", [
                nd("s3", "节B1a", [
                    nd("l4c", "条B1", [nd("l5b", "款B1")]),
                ]),
            ]),
        ]),
    ]);
}

test("E1 默认仍是 3 级：第 4/5 层不编号（升级不改旧行为）", () => {
    const p = N.buildPlan(deepTree());
    assert.equal(byId(p, "l4"), undefined);
    assert.equal(byId(p, "l5"), undefined);
    assert.equal(byId(p, "b2").to, "第02部 部B");
    assert.equal(byId(p, "c3").to, "第03章 章B1");
});

test("E2 maxLevel=5：四五层出号，默认 1/2 连续、3/4/5 按上级重排", () => {
    const p = N.buildPlan(deepTree(), {maxLevel: 5});
    assert.equal(byId(p, "b2").to, "第02部 部B");
    assert.equal(byId(p, "c3").to, "第03章 章B1", "章全书连续");
    assert.equal(byId(p, "s3").to, "第01节 节B1a", "节按章重排");
    assert.equal(byId(p, "l4").to, "第01条 条A1");
    assert.equal(byId(p, "l4b").to, "第02条 条A2");
    assert.equal(byId(p, "l4c").to, "第01条 条B1", "第四级按上一级重排");
    assert.equal(byId(p, "l5").to, "第01款 款A1");
    assert.equal(byId(p, "l5b").to, "第01款 款B1");
});

test("E3 maxLevel 从 5 降到 2：超出的 3/4/5 层自动剥前缀恢复原标题", () => {
    const tree = deepTree();
    applyPlan(tree, N.buildPlan(tree, {maxLevel: 5}));
    assert.equal(tree.children[0].children[0].children[0].title, "第01节 节A1a");
    const p = N.buildPlan(tree, {maxLevel: 2});
    assert.equal(byId(p, "s1").to, "节A1a");
    assert.equal(byId(p, "l4").to, "条A1");
    assert.equal(byId(p, "l5").to, "款A1");
    assert.equal(byId(p, "l4c").reason, "beyond");
    applyPlan(tree, p);
    assert.equal(tree.children[0].children[0].children[0].title, "节A1a");
    assert.equal(byId(N.buildPlan(tree, {maxLevel: 2}), "l4"), undefined, "降级后幂等");
});

test("E4 每级计数方式可改：把章设成 local → 每部下章号从 01 重排", () => {
    const p = N.buildPlan(deepTree(), {
        maxLevel: 3, counters: {1: "global", 2: "local", 3: "local"},
    });
    assert.equal(byId(p, "c1").to, "第01章 章A1");
    assert.equal(byId(p, "c2").to, "第02章 章A2");
    assert.equal(byId(p, "c3").to, "第01章 章B1", "换部后章号回到 01");
});

test("E5 五级全设 global → 每层都全书连续", () => {
    const c = {1: "global", 2: "global", 3: "global", 4: "global", 5: "global"};
    const p = N.buildPlan(deepTree(), {maxLevel: 5, counters: c});
    assert.equal(byId(p, "c3").to, "第03章 章B1");
    assert.equal(byId(p, "s3").to, "第03节 节B1a");
    assert.equal(byId(p, "l4c").to, "第03条 条B1");
    assert.equal(byId(p, "l5b").to, "第02款 款B1");
});

test("E6 maxLevel 钳制在 1~5；非法值回退 3", () => {
    assert.equal(N.clampLevel(0), 3);
    assert.equal(N.clampLevel(9), 5);
    assert.equal(N.clampLevel("abc"), 3);
    assert.equal(N.clampLevel(4), 4);
    assert.equal(N.MAX_LEVEL, 5);
});

test("E7 maxLevel=1：只编一级，其余整支剥前缀", () => {
    const tree = nd("root", "书稿", [nd("b1", "部A", [nd("c1", "章A1")])]);
    applyPlan(tree, N.buildPlan(tree, {maxLevel: 3}));
    const p = N.buildPlan(tree, {maxLevel: 1});
    assert.equal(byId(p, "c1").to, "章A1");
    assert.equal(byId(p, "b1"), undefined, "一级标题本来就对，不重写");
});

test("E8 降级后调回 5 级能补号，且无双前缀", () => {
    const tree = deepTree();
    applyPlan(tree, N.buildPlan(tree, {maxLevel: 5}));
    applyPlan(tree, N.buildPlan(tree, {maxLevel: 2}));
    applyPlan(tree, N.buildPlan(tree, {maxLevel: 5}));
    assert.equal(tree.children[0].children[0].children[0].title, "第01节 节A1a");
    assert.equal(tree.children[0].children[0].children[0].children[0].title, "第01条 条A1");
    assert.equal(N.buildPlan(tree, {maxLevel: 5}).length, 0, "来回切换后幂等");
});

test("E9 占位标题与更深层级共存：第四级的「无命名文档」跳过且不占号", () => {
    const tree = deepTree();
    tree.children[0].children[0].children[0].children[1].title = "无命名文档";
    const p = N.buildPlan(tree, {maxLevel: 5});
    assert.equal(byId(p, "l4b"), undefined);
    assert.equal(byId(p, "l4").to, "第01条 条A1");
    assert.equal(byId(p, "l4c").to, "第01条 条B1");
});

test("E10 自定义格式 + 5 级：每级用自己的模板，换格式仍不叠前缀", () => {
    const F5 = {
        1: "P{nn} {title}", 2: "C{n} {title}", 3: "S{nn}. {title}",
        4: "({n}) {title}", 5: "[{nn}] {title}",
    };
    const tree = deepTree();
    const opt = {maxLevel: 5, formats: F5, stripFormats: [F5]};
    const p = N.buildPlan(tree, opt);
    assert.equal(byId(p, "b1").to, "P01 部A");
    assert.equal(byId(p, "c3").to, "C3 章B1");
    assert.equal(byId(p, "l5b").to, "[01] 款B1");
    applyPlan(tree, p);
    assert.equal(N.buildPlan(tree, opt).length, 0, "自定义 5 级格式幂等");
});

/* ===== F 系列：v0.4.0 新内置编号体系（2026-11-07 14:26 用户指定） =====
   1【title】全书连续 / 【1】title 按上一级 / 第1部 按上一级
   / 第1章 按上上级 / 第{parentN}.{n}节 按上一级                        */
const V4 = () => ({
    formats: N.BUILTIN_V4_FORMATS,
    counters: N.BUILTIN_V4_COUNTERS,
    maxLevel: N.BUILTIN_V4_MAX_LEVEL,
});

function v4Tree() {
    return nd("root", "书稿", [
        nd("a1", "一级甲", [
            nd("b1", "二级甲1", [
                nd("c1", "三级甲1-1", [
                    nd("d1", "章甲1", [nd("e1", "节甲1a"), nd("e2", "节甲1b")]),
                    nd("d2", "章甲2"),
                ]),
                nd("c2", "三级甲1-2", [nd("d3", "章甲3")]),
            ]),
            nd("b2", "二级甲2", [nd("c3", "三级甲2-1", [nd("d4", "章乙1")])]),
        ]),
        nd("a2", "一级乙", [
            nd("b3", "二级乙1", [nd("c4", "三级乙1-1", [nd("d5", "章丙1")])]),
        ]),
    ]);
}

test("F1 新内置默认常量：五级模板 / 三种计数 / 默认 5 级", () => {
    assert.equal(N.BUILTIN_V4_FORMATS[1], "{n}【{title}】");
    assert.equal(N.BUILTIN_V4_FORMATS[3], "第{n}篇{title}");   // v0.7.2 由「第{n}部」改成「篇」
    assert.equal(N.BUILTIN_V4_FORMATS[4], "第{n}章 {title}");
    assert.equal(N.BUILTIN_V4_FORMATS[5], "第{parentN}.{n}节 {title}");
    assert.deepEqual(N.BUILTIN_V4_COUNTERS,
        {1: "global", 2: "local", 3: "local", 4: "grandlocal", 5: "local"});
    assert.equal(N.BUILTIN_V4_MAX_LEVEL, 5);
    assert.deepEqual(N.COUNTER_MODES, ["global", "local", "grandlocal"]);
});

test("F2 {parentN}/{parentNN} 渲染：父级章号 + 本级节号", () => {
    const F = N.BUILTIN_V4_FORMATS;
    assert.equal(N.renderTemplate(F[5], 5, 2, "试验设计", {parentIndex: 1}), "第1.2节 试验设计");
    assert.equal(N.renderTemplate(F[5], 5, 11, "附录", {parentIndex: 12}), "第12.11节 附录");
    assert.equal(N.renderTemplate("第{parentNN}.{nn}节 {title}", 5, 1, "甲", {parentIndex: 3}),
        "第03.01节 甲");
    assert.equal(N.renderTemplate(F[5], 5, 1, "甲"), "第0.1节 甲", "无父级时退化为 0，不写 undefined");
});

test("F3 五级完整输出逐字符合用户给的样例（含 grandlocal 章号跨部连号）", () => {
    const p = N.buildPlan(v4Tree(), V4());
    assert.equal(byId(p, "a1").to, "1【一级甲】");
    assert.equal(byId(p, "a2").to, "2【一级乙】", "一级全书连续");
    assert.equal(byId(p, "b1").to, "【1】二级甲1");
    assert.equal(byId(p, "b2").to, "【2】二级甲2");
    assert.equal(byId(p, "b3").to, "【1】二级乙1", "二级换上级后重排");
    assert.equal(byId(p, "c1").to, "第1篇三级甲1-1");
    assert.equal(byId(p, "c2").to, "第2篇三级甲1-2");
    assert.equal(byId(p, "c3").to, "第1篇三级甲2-1", "三级换上级后重排");
    // 四级按「上上级」重排：同一【1】下的 3 个章跨两个部连号 1/2/3，换【2】回到 1
    assert.equal(byId(p, "d1").to, "第1章 章甲1");
    assert.equal(byId(p, "d2").to, "第2章 章甲2");
    assert.equal(byId(p, "d3").to, "第3章 章甲3", "跨部不回 1（上上级还是 b1）");
    assert.equal(byId(p, "d4").to, "第1章 章乙1", "换到 b2 才重排");
    assert.equal(byId(p, "d5").to, "第1章 章丙1", "换到一级乙也重排");
    assert.equal(byId(p, "e1").to, "第1.1节 节甲1a", "父章号 1 + 本节号 1");
    assert.equal(byId(p, "e2").to, "第1.2节 节甲1b");
});

test("F4 grandlocal 与 local 的区别：同祖父连号、换父不重置", () => {
    const t = v4Tree();
    const asLocal = Object.assign(V4(), {
        counters: {1: "global", 2: "local", 3: "local", 4: "local", 5: "local"},
    });
    assert.equal(byId(N.buildPlan(t, asLocal), "d3").to, "第1章 章甲3",
        "local 时换部就重排");
    assert.equal(byId(N.buildPlan(t, V4()), "d3").to, "第3章 章甲3",
        "grandlocal 时换部继续数");
});

test("F5 新体系连续跑两遍幂等（成对的【】后缀不会反复剥）", () => {
    const t = v4Tree();
    applyPlan(t, N.buildPlan(t, V4()));
    assert.equal(N.buildPlan(t, V4()).length, 0);
    assert.equal(t.children[0].title, "1【一级甲】");
});

test("F6 成对剥离保护：只在前缀命中时才剥后缀，手写『附录】』不受伤", () => {
    const F = N.BUILTIN_V4_FORMATS;
    assert.equal(N.stripByFormats("1【绪论】", [F]), "绪论");
    assert.equal(N.stripByFormats("附录】", [F]), "附录】", "手写的右书名号不能被当成编号后缀");
    assert.equal(N.stripByFormats("【2】二级甲", [F]), "二级甲");
    assert.equal(N.stripByFormats("第12.11节 附录", [F]), "附录");
    assert.equal(N.stripByFormats("第01部 绪论", [F]), "绪论", "旧版编号也能剥掉");
});

test("F7 从 v0.3 已编号的书稿换到新体系：不叠前缀、无旧号残留", () => {
    const t = nd("root", "书稿", [
        nd("a1", "第01部 一级甲", [nd("b1", "第01章 二级甲1", [nd("c1", "第01节 三级甲1-1")])]),
    ]);
    const p = N.buildPlan(t, V4());
    assert.equal(byId(p, "a1").to, "1【一级甲】");
    assert.equal(byId(p, "b1").to, "【1】二级甲1");
    assert.equal(byId(p, "c1").to, "第1篇三级甲1-1");
    applyPlan(t, p);
    assert.ok(t.children[0].title.indexOf("第01部") < 0, "旧前缀不能残留");
    assert.equal(N.buildPlan(t, V4()).length, 0, "换完幂等");
});

test("F8 normalizeCounters 认第三种模式，未知值回退", () => {
    assert.deepEqual(N.normalizeCounters({1: "grandlocal"}),
        {1: "grandlocal", 2: "global", 3: "local", 4: "local", 5: "local"});
    assert.equal(N.normalizeCounters({4: "nonsense"})[4], "local");
});

test("F9 空模板回退可指定为新的内置默认", () => {
    const f = N.normalizeFormats({1: "  ", 2: "", 3: null}, N.BUILTIN_V4_FORMATS);
    assert.equal(f[1], "{n}【{title}】");
    assert.equal(f[2], "【{n}】{title}");
    assert.equal(f[5], "第{parentN}.{n}节 {title}");
    assert.equal(N.normalizeTemplate("   ", 1, N.BUILTIN_V4_FORMATS), "{n}【{title}】");
});

test("F10 新口径的已知代价：手写『第1章』与新模板同形，会被当成插件前缀", () => {
    const t = nd("root", "书稿", [nd("a", "第1章 绪论")]);
    assert.equal(N.buildPlan(t, V4())[0].to, "1【绪论】");
    // 中文数字、带小数、两位补零的旧号不受影响
    assert.equal(N.stripByFormats("第一章 绪论", [N.BUILTIN_V4_FORMATS]), "第一章 绪论");
    assert.equal(N.stripByFormats("第1.1 结果", [N.BUILTIN_V4_FORMATS]), "第1.1 结果");
});

/* ---- v0.7.0 统一词表：文档标题侧也认 fn ---- */
test("U71 文档标题模板支持 {fn1}~{fn5} 与 {fn}", () => {
    const ctx = {fn: [, 2, 1, 3], parentIndex: 1, fallback: N.BUILTIN_V4_FORMATS};
    assert.equal(N.renderTemplate("{fn1}【{title}】", 1, 2, "BBBB", ctx), "2【BBBB】");
    // v0.8.5：{fnK} = 第 K 级的单个序号（fn1=2、fn2=1、fn3=3）；要完整号自己拼
    assert.equal(N.renderTemplate("第{fn2}节 {title}", 2, 1, "XX", ctx), "第1节 XX");
    assert.equal(N.renderTemplate("第{fn3}节 {title}", 3, 3, "XX", ctx), "第3节 XX");
    assert.equal(N.renderTemplate("第{fn3}章 {title}", 3, 3, "YY", ctx), "第3章 YY");
    // 组合出完整号：{fn1}.{fn2}.{fn3} = 2.1.3
    assert.equal(N.renderTemplate("第{fn1}.{fn2}.{fn3}节 {title}", 3, 3, "XX", ctx), "第2.1.3节 XX");
    assert.equal(N.renderTemplate("{fn} {title}", 3, 3, "ZZ", ctx), "2.1.3 ZZ");
});

test("U72 旧写法在文档侧照旧（{n}/{parentN}/{nn} 完全不变）", () => {
    const ctx = {fn: [, 3, 2], parentIndex: 3, fallback: N.BUILTIN_V4_FORMATS};
    assert.equal(N.renderTemplate("第{parentN}.{n}节 {title}", 2, 2, "节", ctx), "第3.2节 节");
    assert.equal(N.renderTemplate("第{nn}章 {title}", 2, 7, "章", ctx), "第07章 章");
    assert.equal(N.renderTemplate("{n}【{title}】", 1, 4, "A", ctx), "4【A】");
});

/* ---- v0.7.1 数字输出格式 ---- */
test("U73 文档标题模板的数字格式：cn / CN / a / o / i / 补零", () => {
    const ctx = {fn: [, 1, 2], fallback: N.BUILTIN_V4_FORMATS};
    assert.equal(N.renderTemplate("第{fn1:cn}章 {title}", 1, 1, "绪论", ctx), "第一章 绪论");
    assert.equal(N.renderTemplate("第{fn1:CN}章 {title}", 1, 1, "绪论", ctx), "第壹章 绪论");
    assert.equal(N.renderTemplate("{fn1:a}) {title}", 1, 1, "A", ctx), "a) A");
    assert.equal(N.renderTemplate("{fn1:o} {title}", 1, 1, "甲", ctx), "① 甲");
    assert.equal(N.renderTemplate("{fn1:i}. {title}", 1, 1, "roman", ctx), "i. roman");
    assert.equal(N.renderTemplate("{fn1:03}【{title}】", 1, 1, "甲", ctx), "001【甲】");
    // v0.8.5：{fn2} 是第 2 级单个序号（=2）
    assert.equal(N.renderTemplate("第{fn2:cn}节 {title}", 2, 2, "乙", ctx), "第二节 乙");
    assert.equal(N.renderTemplate("第{fn2:02}节 {title}", 2, 2, "乙", ctx), "第02节 乙");
    // 复合号逐段转换仍成立：{fn1}.{fn2} = 1.2 → 一.二
    assert.equal(N.renderTemplate("第{fn1:cn}.{fn2:cn}节 {title}", 2, 2, "乙", ctx), "第一.二节 乙");
});

test("U74 带格式的旧号能被剥掉（否则会叠成「一第一章」）", () => {
    const fmts = N.normalizeFormats({1: "第{fn1:cn}章 {title}"});
    assert.equal(N.stripByFormats("第一章 绪论", [fmts]), "绪论");
    assert.equal(N.stripByFormats("第十一章 绪论", [fmts]), "绪论");
    const fmts2 = N.normalizeFormats({1: "{fn1:03}【{title}】"});
    assert.equal(N.stripByFormats("001【绪论】", [fmts2, fmts]), "绪论");
    // 幂等：连剥两层也不出错
    assert.equal(N.stripByFormats("第一章 第一章 绪论", [fmts]), "绪论");
});

/* ---- v0.7.2 第 3 级默认由「部」改「篇」 ---- */
test("U75 默认第3级「第{n}篇{title}」；历史上的「第N部 …」仍能剥掉再套新模板", () => {
    const nd = (id, title, ch) => ({id, title, children: ch || [], order: null});
    const tree = nd("r", "书", [nd("a", "一级甲", [nd("b", "二级甲", [nd("c", "第3部 三级甲")])])]);
    const p = N.buildPlan(tree, {formats: N.BUILTIN_V4_FORMATS,
                                 counters: N.BUILTIN_V4_COUNTERS, maxLevel: 5});
    assert.equal(byId(p, "c").to, "第1篇三级甲", "旧「部」前缀被剥掉，换成「篇」且不再补空格");
    // 幂等：再跑一遍零改动
    const p2 = N.buildPlan(nd("r", "书", [nd("a", "1【一级甲】", [nd("b", "【1】二级甲", [nd("c", "第1篇三级甲")])])]),
        {formats: N.BUILTIN_V4_FORMATS, counters: N.BUILTIN_V4_COUNTERS, maxLevel: 5});
    assert.equal(p2.filter((x) => x.id === "c").length, 0, "第二遍不再改名");
});

/* ---- v0.7.6 剥号优先级事故（【教材与专著】5 章被写成「第N章 N】标题」） ---- */
const TPL_USER = {"1": "【{title}】", "2": "第{n}章 {title}", "3": "{parentN}.{n} {title}",
                  "4": "第{parentN}.{n}节 {title}", "5": "第{parentN}.{n}节 {title}"};
const TPL_LAST = {"1": "{n}【{title}】", "2": "【{n}】{title}", "3": "第{n}篇{title}",
                  "4": "第{n}章 {title}", "5": "第{parentN}.{n}节 {title}"};

test("U76 纯字面量模板（【{title}】）不得抢剥带数字形态（【3】…）", () => {
    const list = [TPL_USER, TPL_LAST, N.BUILTIN_V4_FORMATS];
    // 关键：用户第 1 级模板 head 只有「【」，老实现会先把「【」吃掉，留下 3】
    assert.equal(N.stripByFormats("【3】Tidyverse教程", list), "Tidyverse教程");
    assert.equal(N.stripByFormats("第3章 【3】Tidyverse教程", list), "Tidyverse教程");
    // 用户模板自身的产出（无数字）仍能剥
    assert.equal(N.stripByFormats("【Tidyverse教程】", list), "Tidyverse教程");
});

test("U77 已经坏成「N】标题」的能自愈（残渣兜底，不再永久坏）", () => {
    const list = [TPL_USER, TPL_LAST, N.BUILTIN_V4_FORMATS];
    assert.equal(N.stripByFormats("3】Tidyverse教程", list), "Tidyverse教程");
    assert.equal(N.stripByFormats("第3章 3】Tidyverse教程", list), "Tidyverse教程");
    assert.equal(N.stripByFormats("第7章 7】格式化输出", list), "格式化输出");
    // 重编后应回到正确形态
    const base = N.stripByFormats("第4章 4】回归与拟合", list);
    assert.equal(N.makeTitle(2, 4, base, TPL_USER, {parentIndex: 0, fn: [, 1, 4]}), "第4章 回归与拟合");
});

test("U78 残渣兜底不误伤 4 位年份与无括号数字", () => {
    const list = [TPL_USER, TPL_LAST, N.BUILTIN_V4_FORMATS];
    ["2024）年度总结", "3 个方法", "12345】正常标题"].forEach((t) => {
        assert.equal(N.stripByFormats(t, list), t, "不该剥：" + t);
    });
});

/* ---- v0.8.2 切换编号前自动剔老号（历史模板恒定进剥离清单） ---- */
test("U79 换过默认后，老形态「第N篇」仍能被剥（真机 151 篇的根因）", () => {
    const cur = {"1": "{n}【{title}】", "2": "【{n}】{title}", "3": "{parentN}.{n} {title}",
                 "4": "第{parentN}.{n}节 {title}", "5": "第{parentN}.{n}节 {title}"};
    const tree = nd("r", "书", [nd("a", "1【章一】", [nd("b", "1.2 第2篇vscode配置")])]);
    const p = N.buildPlan(tree, {formats: cur, maxLevel: 3});
    // b 是第 2 级 → 套第 2 级模板「【{n}】{title}」，关键是「第2篇」被剔掉了
    assert.equal(byId(p, "b").to, "【1】vscode配置", "第N篇 必须被剔掉后再套新模板");
});

test("U80 括号处理：模板包【】时脱一层，不包时保留用户方括号", () => {
    // 只脱最外层一对，且只用于「模板自己也包【】」的场合
    assert.equal(N.stripOuterBrackets("【AI】"), "AI");
    assert.equal(N.stripOuterBrackets("【E 【AI】】"), "E 【AI】", "只脱一层，不递归");
    assert.equal(N.stripOuterBrackets("没有括号"), "没有括号");
    // 模板自己包【】→ 脱一层，不会套成 01【【AI相关信息】】
    const tree = nd("r", "书", [nd("a", "【AI相关信息】")]);
    const p = N.buildPlan(tree, {formats: {"1": "{n:02}【{title}】"}, maxLevel: 1});
    assert.equal(byId(p, "a").to, "01【AI相关信息】");
    // 模板不包【】→ 用户方括号原样保留（否则会吃掉【审稿意见】这种真标题）
    const p2 = N.buildPlan(nd("r", "书", [nd("a", "【审稿意见】")]),
        {formats: {"1": "第{n}章 {title}"}, maxLevel: 1});
    assert.equal(byId(p2, "a").to, "第1章 【审稿意见】");
});

test("U81 换模板再换回来：任一代形态都能被剔干净（不叠前缀）", () => {
    const cur = {"1": "{n:02}【 {title}】"};
    const old = N.stripByFormats("03【 第3篇 个人简介】", [cur, N.HISTORY_FORMATS[2]]);
    assert.equal(old, "个人简介");
    const p = N.buildPlan(nd("r", "书", [nd("a", "第3篇 个人简介")]),
        {formats: cur, maxLevel: 1});
    assert.equal(byId(p, "a").to, "01【 个人简介】");
});

test("U82 残渣兜底不误伤普通数字（3 个方法 / 2024 年度总结）", () => {
    const cur = {"1": "{prefix}.{n}"};
    ["3 个方法", "2024 年度总结"].forEach((t) => {
        assert.equal(N.stripByFormats(t, [cur, N.BUILTIN_V4_FORMATS]), t, "不该剥：" + t);
    });
    /* v0.8.6 已知代价：{prefix} 现在按复合号参与剥号（\d+(\.\d+)*），
     * 所以开头的「1.5」会被当成 `{prefix}.{n}` 的号剥掉。
     * 文档标题不会这么起名，正文标题也不该以小数点数字开头；与 v0.8.4
     *「.5 小时 → 小时」同一个取舍：编号必须收敛。 */
    assert.equal(N.stripByFormats("1.5 倍速", [cur]), "倍速");
});

/* ---- v0.8.6 {prefix}：上一级文档实际显示的号 ---- */
test("U83 {prefix} 取上一级实际显示的号，能拼出父子号", () => {
    const t = nd("root", "书稿", [nd("a", "甲", [nd("b", "乙", [nd("c", "丙")])])]);
    const opt = {
        formats: N.normalizeFormats({1: "{n}【{title}】", 2: "{parentN}.{n} {title}",
                                     3: "第{prefix}.{n}节 {title}"}),
        counters: {1: "global", 2: "local", 3: "local"},
        maxLevel: 3,
    };
    const p = N.buildPlan(t, opt);
    assert.equal(byId(p, "a").to, "1【甲】");
    assert.equal(byId(p, "b").to, "1.1 乙");
    // 父（2 级）实际显示 1.1 → 3 级拼成 第1.1.1节
    assert.equal(byId(p, "c").to, "第1.1.1节 丙");
    // 幂等：把结果写回去再算一遍，零改动
    applyPlan(t, p);
    assert.equal(N.buildPlan(t, opt).length, 0, "第二遍零改动");
});

test("U84 范围根没有父号：{prefix} 为空，不产生多余的点", () => {
    const t = nd("root", "书稿", [nd("a", "甲"), nd("b", "乙")]);
    const p = N.buildPlan(t, {
        formats: N.normalizeFormats({1: "{prefix}{n}【{title}】", 2: "{n} {title}", 3: "{n} {title}"}),
        counters: {1: "global", 2: "local", 3: "local"},
        maxLevel: 3,
    });
    assert.equal(byId(p, "a").to, "1【甲】");
    assert.equal(byId(p, "b").to, "2【乙】");
});
