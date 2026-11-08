"use strict";
/* v0.8.9 编号元数据纯函数单测：node test/meta_unit.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../src/numbering.js");

function nd(id, title, children, path) {
    return { id, title, children: children || [], order: null, path: path || ("/" + id + ".sy") };
}
function sample() {
    return nd("root", "书稿", [
        nd("buA", "绪论", [
            nd("zhA1", "研究背景", [
                nd("jiA1a", "国内外现状", [], "/root/buA/zhA1/jiA1a.sy"),
            ], "/root/buA/zhA1.sy"),
        ], "/root/buA.sy"),
        nd("buB", "材料与方法", [], "/root/buB.sy"),
    ], "/root.sy");
}

test("M1 docNumMeta 只输出 3 个必需字段（v0.9.1）", () => {
    const s = N.docNumMeta("20260101010101-aaaaaaa", "1.1.1.1", "20260101010101-ttttttt");
    assert.equal(s, '{"rootID":"20260101010101-aaaaaaa","rootNum":"1.1.1.1","targetId":"20260101010101-ttttttt"}');
    const o = JSON.parse(s);
    assert.equal(o.rootID, "20260101010101-aaaaaaa");
    assert.equal(o.rootNum, "1.1.1.1");
    assert.equal(o.targetId, "20260101010101-ttttttt");
    assert.equal("CustomNum" in o, false, "冗余字段 CustomNum 已删");
    assert.equal("CurrentNum" in o, false, "冗余字段 CurrentNum 已删");
});
test("M2 docNumMeta 空值容错", () => {
    const s = N.docNumMeta(null, undefined, null);
    assert.deepEqual(JSON.parse(s), { rootID: "", rootNum: "", targetId: "" });
    assert.equal(JSON.parse(N.docNumMeta("R", "1.2", "T")).targetId, "T");
});
test("M3 decodeIalText 反转义 HTML 实体", () => {
    const raw = "&#123;&quot;rootNum&quot;:&quot;1.1.1.1&quot;&#125;";
    assert.equal(N.decodeIalText(raw), '{"rootNum":"1.1.1.1"}');
});
test("M4 parseIalMeta 从真实 ial 解析", () => {
    const ial = '{: title="【1】氮循环" custom-doc-num-meta="&#123;&quot;rootID&quot;:&quot;R&quot;,&quot;rootNum&quot;:&quot;1.1&quot;,&quot;CustomNum&quot;:&quot;1.1&quot;,&quot;CurrentNum&quot;:1&#125;"}';
    const m = N.parseIalMeta(ial);
    assert.deepEqual(m, { rootID: "R", rootNum: "1.1", CustomNum: "1.1", CurrentNum: 1 });
});
test("M4b 旧 5 字段属性仍可读（不重写历史文档也能用）", () => {
    const old = '{: custom-doc-num-meta="&#123;&quot;rootID&quot;:&quot;R&quot;,&quot;rootNum&quot;:&quot;1.2.3&quot;,&quot;CustomNum&quot;:&quot;3&quot;,&quot;CurrentNum&quot;:3,&quot;targetId&quot;:&quot;T&quot;&#125;"}';
    const m = N.parseIalMeta(old);
    assert.equal(m.rootID, "R");
    assert.equal(m.rootNum, "1.2.3");
    assert.equal(m.targetId, "T");
});
test("M4c 新 3 字段属性可读", () => {
    const now = '{: custom-doc-num-meta="&#123;&quot;rootID&quot;:&quot;R&quot;,&quot;rootNum&quot;:&quot;1.2.3&quot;,&quot;targetId&quot;:&quot;T&quot;&#125;"}';
    assert.deepEqual(N.parseIalMeta(now), { rootID: "R", rootNum: "1.2.3", targetId: "T" });
});
test("M5 parseIalMeta 缺失/坏值返回 null", () => {
    assert.equal(N.parseIalMeta('{: custom-doc-num="1"}'), null);
    assert.equal(N.parseIalMeta('{: custom-doc-num-meta="not-json"}'), null);
    assert.equal(N.parseIalMeta(""), null);
});
test("M6 topDocIdOf 取 path 第一段", () => {
    assert.equal(N.topDocIdOf("/20260101010101-aaaaaaa/child/grand.sy"), "20260101010101-aaaaaaa");
    assert.equal(N.topDocIdOf("/20260101010101-aaaaaaa.sy"), "20260101010101-aaaaaaa");
    assert.equal(N.topDocIdOf("/.sy"), "");
});
test("M7 emitMeta 默认关闭，plan 结构不变", () => {
    const p = N.buildPlan(sample());
    assert.ok(p.length > 0);
    p.forEach((x) => {
        assert.equal(Object.prototype.hasOwnProperty.call(x, "chain"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(x, "current"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(x, "path"), false);
    });
});
test("M8 emitMeta 带出完整链/本级序号/path", () => {
    const t = sample();
    const p = N.buildPlan(t, { emitMeta: true });
    const a = p.find((x) => x.id === "zhA1");
    const b = p.find((x) => x.id === "jiA1a");
    const other = p.find((x) => x.id === "buB");
    assert.ok(a && b && other);
    assert.match(a.chain, /^\d+(\.\d+)*$/);
    assert.match(b.chain, /^\d+(\.\d+)*$/);
    assert.ok(b.chain.length > a.chain.length, "子级链必须比父级长");
    assert.ok(b.chain.indexOf(a.chain) === 0, "子级链以父级链开头（只含祖先链）");
    assert.equal(a.path, "/root/buA/zhA1.sy");
    assert.equal(typeof a.current, "number");
});
test("M9 祖先链不含兄弟分支", () => {
    const t = sample();
    N.buildPlan(t, { emitMeta: true });
    const buA = t.children[0], buB = t.children[1];
    assert.ok(buA.chain && buB.chain);
    assert.notEqual(buA.chain, buB.chain);
    assert.equal(buB.chain, "2", "同级第二篇不应把第一篇算进链");
    const zhA1 = buA.children[0];
    assert.ok(zhA1.chain.indexOf(buA.chain) === 0);
});
