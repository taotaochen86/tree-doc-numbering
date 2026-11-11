/* v1.2.1 离线单测：直接加载 build.py 生成的 index.js 纯函数层，验证文档树 1~7 级。
 * 运行：node test/level7_unit.js
 * 注意：src/numbering.js 是 v0.9.4 历史快照，构建以 fusion 基线为准，所以这里测生成物。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const ROOT = path.join(__dirname, "..");
const built = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

const marker = '    if (typeof globalThis !== "undefined") globalThis.DocNumbering = api;';
const i = built.indexOf(marker);
assert.ok(i > 0, "找不到 DocNumbering 导出锚点");
const end = built.indexOf("})(typeof globalThis", i);
assert.ok(end > i, "找不到纯函数层结束锚点");
const code = built.slice(0, built.indexOf("\n", end) + 1);
const ctx = {console, globalThis: null};
vm.createContext(ctx);
ctx.globalThis = ctx;
vm.runInContext(code, ctx);
const DN = ctx.DocNumbering;
assert.ok(DN && DN.buildPlan, "纯函数层未加载成功");

function nd(id, title, children) {
    return {id, title, children: children || [], order: null};
}
function deepTree(depth) {
    let node = nd("L" + depth, "第" + depth + "层标题", []);
    for (let d = depth - 1; d >= 1; d--) node = nd("L" + d, "第" + d + "层标题", [node]);
    return nd("root", "书稿", [node]);
}

test("LV1 MAX_LEVEL = 7，默认仍 5 级", () => {
    assert.equal(DN.MAX_LEVEL, 7);
    assert.equal(DN.BUILTIN_V4_MAX_LEVEL, 5, "默认层级不应被擅自改成 7");
});

test("LV2 clampLevel 覆盖 6/7 并把 8 裁到 7", () => {
    assert.equal(DN.clampLevel(5), 5);
    assert.equal(DN.clampLevel(6), 6);
    assert.equal(DN.clampLevel(7), 7);
    assert.equal(DN.clampLevel(8), 7);
    assert.equal(DN.clampLevel(99), 7);
    assert.equal(DN.clampLevel(0), DN.DEFAULT_MAX_LEVEL);
});

test("LV3 normalizeFormats / Counters 都有 1~7 级且 6/7 非空", () => {
    const f = DN.normalizeFormats({}, DN.BUILTIN_V4_FORMATS);
    const c = DN.normalizeCounters({});
    for (let lv = 1; lv <= 7; lv++) {
        assert.ok(f[lv], "formats[" + lv + "] 为空");
        assert.ok(c[lv], "counters[" + lv + "] 为空");
    }
    assert.equal(f[6], "{prefix}.{n} {title}");
    assert.equal(f[7], "{prefix}.{n} {title}");
    assert.equal(c[6], "local");
    assert.equal(c[7], "local");
});

test("LV4 {fn6} / {fn7} / {fn} 全链渲染到第 7 段", () => {
    const fn = []; fn[1] = 1; fn[2] = 2; fn[3] = 3; fn[4] = 4;
    fn[5] = 5; fn[6] = 6; fn[7] = 7;
    const ctx7 = {fn: fn, parentIndex: 6, parentNum: "1.2.3.4.5.6"};
    assert.equal(DN.renderTemplate("{fn6}.{fn7} {title}", 7, 7, "深层", ctx7), "6.7 深层");
    assert.equal(DN.renderTemplate("{fn} {title}", 7, 7, "深层", ctx7), "1.2.3.4.5.6.7 深层");
    assert.equal(DN.renderTemplate("{fn5:cn} {title}", 7, 7, "深层", ctx7), "五 深层");
});

test("LV5 buildPlan 能把 7 层树一路编到第 7 级", () => {
    const fmts = DN.normalizeFormats({}, DN.BUILTIN_V4_FORMATS);
    const p = DN.buildPlan(deepTree(7), {
        maxLevel: 7, formats: fmts,
        counters: DN.normalizeCounters({}),
        skipPlaceholder: true, writeAttrs: false,
    });
    assert.ok(p.length >= 7, "7 层树应产生至少 7 项编号计划，实际 " + p.length);
    const l7 = p.find((x) => x.id === "L7");
    assert.ok(l7, "第 7 层文档没有进入编号计划");
    assert.ok(/1\.2\.3\.4\.5\.6\.7|7/.test(l7.to), "第 7 层标题没带上编号: " + l7.to);
});

test("LV6 maxLevel=5 时第 6/7 层不编号（行为不变）", () => {
    const p = DN.buildPlan(deepTree(7), {
        maxLevel: 5, formats: DN.normalizeFormats({}, DN.BUILTIN_V4_FORMATS),
        counters: DN.normalizeCounters({}), skipPlaceholder: true,
    });
    assert.ok(!p.some((x) => x.id === "L6" && x.to !== x.from),
        "maxLevel=5 时第 6 层不应被加号");
    assert.ok(!p.some((x) => x.id === "L7" && x.to !== x.from),
        "maxLevel=5 时第 7 层不应被加号");
});

test("LV7 剥号规则覆盖 6/7 级模板（换模板不残留旧号）", () => {
    const f7 = DN.normalizeFormats({
        1: "L1.{n} {title}", 2: "L2.{n} {title}", 3: "L3.{n} {title}",
        4: "L4.{n} {title}", 5: "L5.{n} {title}", 6: "L6.{n} {title}", 7: "L7.{n} {title}",
    }, DN.BUILTIN_V4_FORMATS);
    assert.ok(f7[7]);
    const peeled = DN.stripByFormats("L7.3 深层标题", [f7]);
    assert.equal(peeled, "深层标题", "第 7 级旧号没被剥掉: " + peeled);
});

test("LV8 生成物：面板 7 行、占位符校验、文案、UI 双语都已更新", () => {
    assert.ok(built.includes("const docRows = [1, 2, 3, 4, 5, 6, 7].map"));
    assert.ok(built.includes('const fInputs = [1, 2, 3, 4, 5, 6, 7].map((lv) => q("#dn-f" + lv));'));
    assert.ok(built.includes('const cSelects = [1, 2, 3, 4, 5, 6, 7].map((lv) => q("#dn-c" + lv));'));
    assert.ok(built.includes("级（1–7）"));
    assert.ok(built.includes("{fn1}…{fn7}</code>"));
    assert.ok(built.includes('"七级 →": "Level 7 →"'));
    assert.ok(built.includes('"级（1–7）": " levels (1–7)"'));
    assert.ok(/const PH_OK = \/.*fn\[1-7\]/.test(built), "PH_OK 未放行 {fn6}/{fn7}");
    assert.ok(built.includes('"六级 →"'), "UI 中文层级映射缺失");
});

test("LV9 正文标题仍保持 1~5 级（未被本次改动波及）", () => {
    assert.ok(built.includes("const bodyRows = [1, 2, 3, 4, 5].map"));
    assert.ok(built.includes("[1, 2, 3, 4, 5].forEach((lv) => {\n                const el = q(\"#dn-bf\" + lv);"));
    assert.ok(built.includes("{hn1}…{hn5}</code>"));
});
