# -*- coding: utf-8 -*-
"""v1.2.1 补丁步：文档树编号层级上限 5 → 7（正文标题仍 5 级，不动）。
由 apply.py 在 apply_core / apply_b_core / apply_attr_core 之后执行，注入 s。
每处替换都断言锚点命中次数，避免静默漏改。请勿缩进本文件。

设计取舍：只把「上限」扩到 7，BUILTIN_V4_MAX_LEVEL（默认 5）保持不变，
因此不会改变用户已有范围的默认编号行为；在面板点两次「+」即可启用 6/7 级。
"""
def bp(old, new, n=1, label=""):
    global s
    c = s.count(old)
    assert c == n, "LV7-%s 锚点命中 %d 次（期望 %d）: %r" % (label, c, n, old[:90])
    s = s.replace(old, new, n)

# ---------------------------------------------------------------- 1 常量 / 内置默认
bp("    var MAX_LEVEL = 5;", "    var MAX_LEVEL = 7;", 1, "MAX_LEVEL")
bp(r'''    /* 内置默认模板：前三级输出与 v0.2.0 的硬编码逐字一致，升级不会改动用户已有标题。
     * 4/5 级是 2026-11-07 追加「最多 5 级」时给的可改默认值（名称由模板决定，改模板即可）。
     * 每个自动编号范围可以另存一份 formats；没存的继承全局 defaultFormats。 */''',
   r'''    /* 内置默认模板：前三级输出与 v0.2.0 的硬编码逐字一致，升级不会改动用户已有标题。
     * 4/5 级是 2026-11-07 追加「最多 5 级」时给的可改默认值；
     * 6/7 级是 2026-11-11 把文档树层级上限扩到 7 时补的（默认不启用，点 + 才有）。
     * 每个自动编号范围可以另存一份 formats；没存的继承全局 defaultFormats。 */''',
   1, "默认模板注释")
bp(r'''        4: "第{nn}条 {title}",
        5: "第{nn}款 {title}",
    };''',
   r'''        4: "第{nn}条 {title}",
        5: "第{nn}款 {title}",
        6: "第{nn}项 {title}",
        7: "第{nn}目 {title}",
    };''', 1, "DEFAULT_FORMATS 6/7")
bp(r'''    var DEFAULT_COUNTERS = {
        1: "global", 2: "global", 3: "local", 4: "local", 5: "local",
    };''',
   r'''    var DEFAULT_COUNTERS = {
        1: "global", 2: "global", 3: "local", 4: "local", 5: "local", 6: "local", 7: "local",
    };''', 1, "DEFAULT_COUNTERS 6/7")
bp(r'''        4: "第{n}章 {title}",
        5: "第{parentN}.{n}节 {title}",
    };''',
   r'''        4: "第{n}章 {title}",
        5: "第{parentN}.{n}节 {title}",
        6: "{prefix}.{n} {title}",
        7: "{prefix}.{n} {title}",
    };''', 1, "BUILTIN_V4_FORMATS 6/7")
bp(r'''    var BUILTIN_V4_COUNTERS = {
        1: "global", 2: "local", 3: "local", 4: "grandlocal", 5: "local",
    };''',
   r'''    var BUILTIN_V4_COUNTERS = {
        1: "global", 2: "local", 3: "local", 4: "grandlocal", 5: "local", 6: "local", 7: "local",
    };''', 1, "BUILTIN_V4_COUNTERS 6/7")

# ---------------------------------------------------------------- 2 占位符正则（只扩文档树 fn，正文 hn 仍是 1~5）
bp(r'''        var re = /\{(parentNN|parentN|prefix|nn|n|title|fn[1-5]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g;''',
   r'''        var re = /\{(parentNN|parentN|prefix|nn|n|title|fn[1-7]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g;''',
   1, "wildcard 正则")
bp(r'''        return s.replace(/\{(parentNN|parentN|prefix|nn|n|title|fn[1-5]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g,''',
   r'''        return s.replace(/\{(parentNN|parentN|prefix|nn|n|title|fn[1-7]|hn[1-5]|fn|hn)(?::([^}]*))?\}/g,''',
   1, "renderTemplate 正则")
bp(r'''const PH_OK = /^(title|prefix|h1|cn|n|nn|parentN|parentNN|fn[1-5]|hn[1-5]|fn|hn)(:[^}]*)?$/;''',
   r'''const PH_OK = /^(title|prefix|h1|cn|n|nn|parentN|parentNN|fn[1-7]|hn[1-5]|fn|hn)(:[^}]*)?$/;''',
   1, "PH_OK 校验")

# ---------------------------------------------------------------- 3 注释 / 提示文案
bp("        var maxLevel = clampLevel(o.maxLevel || DEFAULT_MAX_LEVEL);  // 1~5 级",
   "        var maxLevel = clampLevel(o.maxLevel || DEFAULT_MAX_LEVEL);  // 1~7 级",
   1, "buildPlan 注释")
bp("         * chain       = 从根到当前节点各层的序号（下标 1~5），供 {fn1}~{fn5} 与 {fn} 组合。 */",
   "         * chain       = 从根到当前节点各层的序号（下标 1~7），供 {fn1}~{fn7} 与 {fn} 组合。 */",
   1, "chain 注释")
bp("     *   {fn1}~{fn5} = 本文档在文档树上第 K 级的序号（单个整数，1.1.1.4 → fn4=4）",
   "     *   {fn1}~{fn7} = 本文档在文档树上第 K 级的序号（单个整数，1.1.1.4 → fn4=4）",
   1, "renderTemplate 词表注释")
bp("        /* v0.7.0：文档树各级序号（{fn1}~{fn5}）。优先用插件算好的祖先链；",
   "        /* v0.7.0：文档树各级序号（{fn1}~{fn7}）。优先用插件算好的祖先链；",
   1, "titleNum 注释")
bp('''                    + "。文档标题可用 {fn1}~{fn5}、{fn}、{n}、{nn}、{parentN}、{parentNN}、{title}、{h1}、{cn}");''',
   '''                    + "。文档标题可用 {fn1}~{fn7}、{fn}、{n}、{nn}、{parentN}、{parentNN}、{title}、{h1}、{cn}");''',
   1, "占位符错误提示")
bp('''            + "</div><span class='dn-field__label'>级（1–5）</span></div>"''',
   '''            + "</div><span class='dn-field__label'>级（1–7）</span></div>"''',
   1, "面板层级范围文案")
bp('''            + "<span class='dn-tag'><code>{fn1}…{fn5}</code> 文档第 K 级号</span>"''',
   '''            + "<span class='dn-tag'><code>{fn1}…{fn7}</code> 文档第 K 级号</span>"''',
   1, "图例 fn 词表")

# ---------------------------------------------------------------- 4 设置面板：7 行 DOM + 7 个输入
bp(r'''        const levelNames = {
            1: "一级", 2: "二级", 3: "三级", 4: "四级", 5: "五级",
        };
        const levelShort = {1: "级", 2: "级", 3: "级", 4: "级", 5: "级"};
        const docRows = [1, 2, 3, 4, 5].map((lv) =>''',
   r'''        const levelNames = {
            1: "一级", 2: "二级", 3: "三级", 4: "四级", 5: "五级", 6: "六级", 7: "七级",
        };
        const levelShort = {1: "级", 2: "级", 3: "级", 4: "级", 5: "级", 6: "级", 7: "级"};
        const docRows = [1, 2, 3, 4, 5, 6, 7].map((lv) =>''',
   1, "面板 7 行 DOM")
bp(r'''        const fInputs = [1, 2, 3, 4, 5].map((lv) => q("#dn-f" + lv));
        const cSelects = [1, 2, 3, 4, 5].map((lv) => q("#dn-c" + lv));''',
   r'''        const fInputs = [1, 2, 3, 4, 5, 6, 7].map((lv) => q("#dn-f" + lv));
        const cSelects = [1, 2, 3, 4, 5, 6, 7].map((lv) => q("#dn-c" + lv));''',
   1, "面板输入数组")
bp(r'''            const samples = ["绪论", "研究背景", "国内外现状", "条目示例", "款目示例"];
            const idxs = [1, 3, 2, 4, 5];''',
   r'''            const samples = ["绪论", "研究背景", "国内外现状", "条目示例", "款目示例", "项目示例", "细目示例"];
            const idxs = [1, 3, 2, 4, 5, 2, 3];''',
   1, "预览 7 级样例")

# ---------------------------------------------------------------- 5 UI 双语映射
bp('''    "五级 →": "Level 5 →",''',
   '''    "七级 →": "Level 7 →",
    "六级 →": "Level 6 →",
    "五级 →": "Level 5 →",''', 1, "UI 中文层级 6/7")
bp('''    "5级 →": "Level 5 →",''',
   '''    "7级 →": "Level 7 →",
    "6级 →": "Level 6 →",
    "5级 →": "Level 5 →",''', 1, "UI 数字层级 6/7")
bp('''    "级（1–5）": " levels (1–5)",''',
   '''    "级（1–7）": " levels (1–7)",''', 1, "UI 层级范围")

print("LV7 文档树层级上限 5 -> 7: OK")
