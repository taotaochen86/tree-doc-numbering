/* v1.2.2 离线单测：正文编号的幂等判定必须以「剥离前原文」为基准。
 *
 * 回归背景：D 方案按 bn 属性精确剥离编号后，把裸标题传给 buildBodyPlan；
 * 旧实现拿 to（带编号）与 b.markdown（剥后裸标题）比较 → 永远不等 →
 * 每轮重写相同内容 → 自动重算自激循环 → 熔断误报「连续 3 轮算出不同结果」。
 *
 * 运行：node test/body_idem_unit.js
 * 注意：src/ 是历史快照，构建以 fusion 基线为准，所以这里直接测生成物。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const built = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const marker = '    if (typeof globalThis !== "undefined") globalThis.BodyNumbering = api;';
const i = built.indexOf(marker);
assert.ok(i > 0, "找不到 BodyNumbering 导出锚点");
const end = built.indexOf("})(typeof globalThis", i);
assert.ok(end > i, "找不到正文纯函数层结束锚点");
const code = built.slice(0, built.indexOf("\n", end) + 1);
const ctx = {console, globalThis: null};
vm.createContext(ctx);
ctx.globalThis = ctx;
vm.runInContext(code, ctx);
const BN = ctx.BodyNumbering;
assert.ok(BN && BN.buildBodyPlan, "正文纯函数层未加载成功");

// 与真机 auto-config.json 的 bodyFormats 一致
const FMT = BN.normalizeBodyFormats({
    1: "{n:cn}、", 2: "（{n:cn}）", 3: "{n}. ", 4: "({n}）", 5: "{n} ",
});
const T1 = "辽宁水利科学技术奖二等奖";
const T2 = "2025年度优秀审稿专家";

/** 造一个「已按 bn 精确剥离」的块：markdown 是裸标题，original 是带编号原文 */
function peeled(id, num, title) {
    return {
        id,
        level: 4,
        markdown: "#### " + title,
        original: "#### " + num + title,
        preStripped: true,
    };
}

function plan(blocks, extra) {
    return BN.buildBodyPlan(Object.assign({
        docTitle: "06【 获奖证书】",
        docNum: "06",
        docNumPad: 2,
        blocks,
        formats: FMT,
        stripFormats: [FMT],
        normalizeDepth: true,
        focus: null,
    }, extra || {}));
}

test("ID1 已编号的整篇：plan 必须为空（修复核心）", () => {
    const r = plan([peeled("a", "一、", T1), peeled("b", "二、", T2)]);
    assert.equal(r.reason, "ok");
    assert.equal(r.plan.length, 0, "标题已正确时不能生成任何改动");
});

test("ID2 对照组：不传 original 会复现旧 bug（plan 非空）", () => {
    const legacy = [
        {id: "a", level: 4, markdown: "#### " + T1, preStripped: true},
        {id: "b", level: 4, markdown: "#### " + T2, preStripped: true},
    ];
    const r = plan(legacy);
    assert.equal(r.plan.length, 2, "缺 original 时退化为旧行为，证明修复确实生效");
    assert.equal(r.plan[0].to, "#### 一、" + T1);
});

test("ID3 真有新标题：仍要正常编号，from 是剥离前原文", () => {
    const r = plan([
        peeled("a", "一、", T1),
        {id: "new", level: 4, markdown: "#### " + T2,
         original: "#### " + T2, preStripped: true},
    ]);
    assert.equal(r.plan.length, 1, "只有新标题该进计划");
    assert.equal(r.plan[0].id, "new");
    assert.equal(r.plan[0].from, "#### " + T2, "from 必须是原文");
    assert.equal(r.plan[0].to, "#### 二、" + T2);
});

test("ID4 编号写错时：from 记原文而不是剥后裸标题", () => {
    const r = plan([
        {id: "a", level: 4, markdown: "#### " + T1,
         original: "#### 三、" + T1, preStripped: true},
    ]);
    assert.equal(r.plan.length, 1);
    assert.equal(r.plan[0].from, "#### 三、" + T1,
        "撤销快照必须能还原成真实旧值，不能是剥掉编号的裸标题");
    assert.equal(r.plan[0].to, "#### 一、" + T1);
});

test("ID5 original 为 null / undefined 时向后兼容（回退 markdown）", () => {
    const r = plan([
        {id: "a", level: 4, markdown: "#### " + T1,
         original: null, preStripped: true},
    ]);
    assert.equal(r.plan.length, 1, "无 original 时按旧口径比较，行为不变");
    assert.equal(r.plan[0].from, "#### " + T1);
});

test("ID6 行尾空格差异不算改动（trimEnd 幂等）", () => {
    const r = plan([
        {id: "a", level: 4, markdown: "#### " + T1,
         original: "#### 一、" + T1 + "   ", preStripped: true},
    ]);
    assert.equal(r.plan.length, 0, "思源会吃掉行尾空格，不能因此反复重写");
});

test("ID7 混合层级（H4 一级 + H5 二级）仍按归一深度编号", () => {
    const r = plan([
        peeled("a", "一、", T1),
        {id: "b", level: 5, markdown: "##### 入选通知",
         original: "##### （一）入选通知", preStripped: true},
        {id: "c", level: 5, markdown: "##### 结题通知",
         original: "##### （二）结题通知", preStripped: true},
    ]);
    assert.equal(r.plan.length, 0, "与《06 获奖证书》真实形态一致：已编号则零改动");
});

test("ID8 整篇 24 个已编号标题：零改动（对应真机 24 项误报）", () => {
    const cn = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
                "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八",
                "十九", "二十", "二十一", "二十二", "二十三", "二十四"];
    const blocks = cn.map((c, k) => peeled("h" + k, c + "、", "标题" + (k + 1)));
    const r = plan(blocks);
    assert.equal(r.plan.length, 0, "24 个标题已全部正确时计划必须为空");
});

test("ID9 未编号的历史文档（preStripped=false）仍走正则剥号，行为不变", () => {
    const r = plan([
        {id: "a", level: 4, markdown: "#### " + T1,
         preStripped: false},
    ]);
    assert.equal(r.plan.length, 1, "历史文档第一次编号该正常生成计划");
    assert.equal(r.plan[0].to, "#### 一、" + T1);
});

test("ID10 生成物含零成本兜底（用已读 mdMap，不新增 API 请求）", () => {
    assert.ok(built.includes("const cur = mdMap.get(p.id);"),
        "bodyPlanFor 的安全闸必须复用本轮 mdMap");
    assert.ok(!built.includes("const mdNow = await this.bodyMarkdowns(list.map"),
        "不应在写入层重读 markdown（会退化成 N 次 API）");
});
