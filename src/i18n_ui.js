/* v0.9.4 UI 中英双语：输出层统一翻译，不改编号逻辑。
 * 语言判据：window.siyuan.config.lang；中文系（zh*）保持中文，其余一律英文。
 * 映射按 key 长度降序替换，长句优先，避免短片段误伤。
 * 内置编号模板、示例中文、控制台日志不走这里。
 */
const UI_EN = {
    "七级 →": "Level 7 →",
    "六级 →": "Level 6 →",
    "五级 →": "Level 5 →",
    "换格式 / 减少层级会自动剥掉旧编号再套新格式。「第1章」与新内置模板同形，会被当作插件编号剥掉（中文数字「第一章」保留）。排除「仅自身」时子文档照常编号，「整支」则连子文档都不编号。撤销后自动编号会暂停，到此处重新开启。": "Switching formats or reducing levels strips old numbers before applying the new format. A hand-written 「第1章」 looks like the built-in template and is stripped (Chinese numerals such as 「第一章」 are safe). Excluding \"Itself only\" still numbers child documents; \"Whole branch\" excludes them too. Automatic numbering pauses after an undo — re-enable it here.",
    "把范围内每篇的内容标题按当前模板编一遍；可整批撤销": "Number body headings in every scoped document with the current template; one batch undo",
    "作用于「自动编号范围」内的文档": "Documents inside \"Auto-numbering scopes\"",
    "启用内容标题快捷键": "Enable body-heading shortcuts",
    "内容标题自动重算开关": "Automatic body renumbering toggle",
    "Ctrl+Alt+1…5 开关": "Ctrl+Alt+1…5 toggle",
    "立即编内容": "Number body now",
    "中文数字": "Chinese numerals",
    "1级 →": "Level 1 →",
    "2级 →": "Level 2 →",
    "3级 →": "Level 3 →",
    "4级 →": "Level 4 →",
    "7级 →": "Level 7 →",
    "6级 →": "Level 6 →",
    "5级 →": "Level 5 →",
    "新增 / 删除 / 拖动 / 改名后约 ": "Recalculates about ",
    " 秒自动重排 · 只改标题，不动正文与 ID": " s after create / delete / drag / rename · titles only, body and IDs untouched",
    "实际显示的号（不是全链）：文档标题里取": "number shown in the title (not the full chain): document titles take ",
    "只取第 4 级那一段（=4），不再返回整条号。": "only the 4th-level segment (=4) is taken, not the full chain.",
    "的显示号（如 1.1，第 1 级没有上级→为空，可写": "'s displayed number (e.g. 1.1; level 1 has no parent → empty; you can write ",
    "zero-padded到 3 位；复合号（2.1）逐段转换 →": "zero-padded to 3 digits; compound numbers (2.1) converted segment by segment →",
    "删除该级，后面各级自动上移补位": "Delete this level; later levels shift up",
    "启用 / 暂停自动编号": "Enable / pause automatic numbering",
    "启用自动编号": "Enable automatic numbering",
    "跳过占位标题": "Skip placeholder titles",
    "全书连续": "Continuous",
    "按上级重排": "Restart per parent",
    "按上上级重排": "Restart per grandparent",
    "默认设置": "Default settings",
    "已自定义": "Customised",
    "整支": "Whole branch",
    "仅自身": "Itself only",
    "文档 ·": "Document ·",
    "罗马 ·": "Roman ·",
    "。只要本级序号用": ". As long as the level number uses ",
    "的显示号。": "'s displayed number.",
    "=本级、": "=current level, ",
    "=上级、": "=parent, ",
    "=所属一级、": "=parent H1, ",
    "一级 →": "Level 1 →",
    "二级 →": "Level 2 →",
    "三级 →": "Level 3 →",
    "四级 →": "Level 4 →",
    "上一级": "parent",
    "本文档": "this document",
    "里取": " takes ",
    "级": "level",
    "删除第 1 级": "Delete level 1",
    "删除第 2 级": "Delete level 2",
    "删除第 3 级": "Delete level 3",
    "删除第 4 级": "Delete level 4",
    "删除第 5 级": "Delete level 5",
    "「无标题 / 无命名文档 / Untitled」等不编号、不占号，改好名字后自动补号": "Placeholder titles (Untitled) get no number and consume none; they are numbered once renamed",
    "检测到编号在两套格式间反复切换（编号范围可能重叠），已暂停自动编号。": "Detected numbers flipping between two formats (scopes may overlap); automatic numbering paused.",
    "还没有设置自动编号范围，先在上面「自动编号范围」里添加文档或笔记本": "No auto-numbering scope yet; add a document or notebook under \"Auto-numbering scopes\" above",
    "把光标所在段落设为对应级标题并编号；没有文档编号的篇自动跳过": "Turn the current paragraph into a heading of that level and number it; documents without a number are skipped",
    "文档标题与内容标题共用一套编号词表 · 每个范围各存一套": "Document titles and body headings share one token set · stored separately per scope",
    "读不到当前段落的文字，未做任何改动，请把光标移回正文再试": "Cannot read the current paragraph; nothing was changed. Move the caret back into the body and retry",
    "编号范围内文档的标题增删改后，停顿 1.5 秒自动重排": "After heading edits in scoped documents, renumber automatically following a 1.5 s pause",
    "正文模板已切换，正在按新模板重排（会先剔除老编号）…": "Body template switched; renumbering with the new template (old numbers stripped first)…",
    "。现在新增 / 删除 / 拖动子文档会自动重排编号": ". Creating, deleting or dragging child documents now renumbers automatically",
    "当前文档标题里没有节编号或章编号，已跳过正文编号": "No section or chapter number in this document title; body numbering skipped",
    "已恢复内置正文模板，正在重排（会先剔除老编号）…": "Built-in body template restored; renumbering (old numbers stripped first)…",
    "换格式 / 减少层级会自动剥掉旧编号再套新格式。": "Switching formats or reducing levels strips old numbers before applying the new format.",
    "内容层级没有计数方式：序号在篇内按层级自然递增": "Body levels have no counter mode: numbers grow naturally with depth",
    "光标不在正文段落里，请点到具体段落再按快捷键": "The caret is not in a body paragraph; click a specific paragraph before using the shortcut",
    "设为自动编号范围（新增/删除/拖动自动重排）": "Set as auto-numbering scope (renumber on create/delete/drag)",
    "改文档内的 H1~H5 · 前缀取本档编号": "Numbers H1–H5 in documents · prefix from this document's number",
    " 处改名，但回读校验超时，请刷新文档树确认": " renames, but read-back verification timed out — refresh the tree to confirm",
    "内容标题快捷键 Ctrl+Alt+1…5": "Body-heading shortcuts Ctrl+Alt+1…5",
    "》的正文编号连续 3 轮都算出不同结果，": "” produced different numbers for 3 consecutive rounds, ",
    "内容标题（示例文档「第2.1节 …」）": "Body headings (example document “2.1 …”)",
    " 处，可用「撤销上次正文编号」整批回退": " places; “Undo last body numbering” rolls back the whole batch",
    "」下的子文档编号已是最新的，无需改动": "” child documents are already up to date, nothing to change",
    " 处，可用「撤销上次正文编号」回退": " places; use “Undo last body numbering” to roll back",
    "请把光标放到正文段落里再按快捷键": "Put the caret in a body paragraph before using the shortcut",
    " 篇的正文编号已是最新，无需改动": " documents already up to date, nothing to change",
    "正文标题编号已是最新，无需改动": "Body headings are already up to date",
    "正文编号快捷键已在设置里关闭": "Body-numbering shortcuts are disabled in settings",
    "每级顺序跟随文档树自定义排序": "Every level follows the tree's custom sort order",
    "改文档名 · 跟随文档树顺序": "Renames document titles · follows tree order",
    "编号：文档标题 + 内容标题": "Number: document titles + body headings",
    "标题体系自动编号：读取中…": "Title numbering: loading…",
    "没有可撤销的上一轮正文编号": "No previous body-numbering round to undo",
    " 个标题块暂时读不到内容，": " heading blocks whose content is temporarily unreadable, ",
    "仅自身不编号（子文档照常）": "Exclude this document only (children still numbered)",
    "实际显示的号（不是全链）：": "number shown in the title (not the full chain): ",
    "取消排除（恢复参与编号）": "Cancel exclusion (number it again)",
    "正文自动编号中断：已改 ": "Automatic body numbering interrupted: changed ",
    "正文批量编号中断：已改 ": "Batch body numbering interrupted: changed ",
    "没有可撤销的上一轮编号": "No previous numbering round to undo",
    "整支不编号（含子文档）": "Exclude this document and its children",
    "内容标题变化后自动重算": "Recalculate after body headings change",
    "数字格式接在名字后面：": "Append the format after the token: ",
    "已取消自动编号范围：": "Cancelled auto-numbering scope: ",
    "已设为自动编号范围：": "Auto-numbering scope set: ",
    "取消该范围的自动编号": "Cancel auto-numbering for this scope",
    " 篇，失败 1 篇（": " documents, 1 failed (",
    "正文编号中断：已改 ": "Body numbering interrupted: changed ",
    "排除（当前已排除）": "Exclusion (currently excluded)",
    "剥掉旧编号、不占号": "Old numbers stripped, no slots consumed",
    "编号设置保存失败：": "Failed to save numbering settings: ",
    "正文批量编号失败：": "Batch body numbering failed: ",
    "已把当前段落设为 ": "Set the current paragraph to level ",
    " 级标题，并重排 ": " and renumbered ",
    "撤销文档标题编号": "Undo document-title numbering",
    "撤销内容标题编号": "Undo body-heading numbering",
    "文档第 K 级号": "number of tree level K",
    "内容第 K 级号": "number of body level K",
    "旧写法照样能用：": "Legacy tokens still work: ",
    "撤销上次内容编号": "Undo last body numbering",
    "编号设置已保存（": "Numbering settings saved (",
    " 级），已重排 ": " levels), renumbered ",
    " 处内容标题编号": " body headings",
    " 处正文标题编号": " body headings numbered",
    "编号中断：已改 ": "Numbering interrupted: changed ",
    "只编号内容标题": "Number body headings only",
    "跳过未命名文档": "Skip untitled documents",
    "完整号自己拼：": "Build the full number yourself: ",
    "正文重排失败：": "Body renumbering failed: ",
    "恢复默认失败：": "Failed to restore defaults: ",
    "正文编号失败：": "Body numbering failed: ",
    "面板打开失败：": "Failed to open panel: ",
    "取消排除失败：": "Failed to cancel exclusion: ",
    "文档树已重排 ": "Tree renumbered: ",
    " 个范围、改 ": " scopes, ",
    "自动编号范围": "Auto-numbering scopes",
    "，编号已重排": ", numbering refreshed",
    "已取消排除「": "Un-excluded “",
    "级（1–7）": " levels (1–7)",
    "恢复内置默认": "Restore built-in defaults",
    "撤销上次编号": "Undo last numbering",
    "立即全部重排": "Renumber all now",
    "树文联动编号": "Tree-Doc Numbering",
    " 处正文编号": " body headings",
    "文档标题改 ": "Document titles changed: ",
    "排除此文档": "Exclude this document",
    "及其子文档": " and its children",
    "（仅自身）": " (itself only)",
    "保存并应用": "Save and apply",
    "排除的文档": "Excluded documents",
    "重排失败：": "Renumbering failed: ",
    "编号失败：": "Numbering failed: ",
    "撤销失败：": "Undo failed: ",
    "排除失败：": "Exclusion failed: ",
    "设置失败：": "Settings failed: ",
    " 篇、共 ": " documents, ",
    "确认写入 ": "Write ",
    "重排中断：": "Renumbering interrupted: ",
    "编号中断：": "Numbering interrupted: ",
    "已排除「": "Excluded “",
    "文档标题": "Document titles",
    "内容标题": "Body headings",
    "标题体系": "Title scheme",
    "编号到第": "Number up to level",
    "减少层级": "Fewer levels",
    "增加层级": "More levels",
    "编号模板": "Template",
    "计数方式": "Counter mode",
    "本文档号": "full number of this document",
    "内容连号": "full body number",
    "实时预览": "Live preview",
    " 个范围": " scopes",
    "范围内 ": "In scope: ",
    "正在写…": "Writing…",
    "已提交 ": "Submitted ",
    "未知错误": "Unknown error",
    " 个标题": " titles changed",
    " 级 →": " levels →",
    "随层级": "By depth",
    "作用于": "Apply to",
    "原标题": "original title",
    "已给 ": "Numbered ",
    "预检：": "Dry run: ",
    "现在编": "Number now",
    "已给「": "Numbered “",
    "」下 ": "” and its ",
    "笔记本": "Notebook",
    "层级": "Level",
    "中文": "Chinese numerals",
    "大写": "uppercase Chinese",
    "字母": "letters",
    "圈码": "circled numbers",
    "补零": "zero-padded",
    "关闭": "Close",
    "移除": "Remove",
    " 处": " places",
    "有 ": "There are ",
    " 篇": " documents",
    "撤销": "Undo"
};
const UI_KEYS = Object.keys(UI_EN).sort((a, b) => b.length - a.length);
function uiIsEn() {
    try {
        if (typeof window === "undefined") return false;
        const raw = String((window.siyuan && window.siyuan.config && window.siyuan.config.lang) || "");
        return !!raw && !/^zh/i.test(raw);
    } catch (e) { return false; }
}
function trText(s) {
    if (!uiIsEn() || s == null) return s;
    let out = String(s);
    if (!/[\u4e00-\u9fff]/.test(out)) return out;
    for (const k of UI_KEYS) {
        if (out.indexOf(k) >= 0) out = out.split(k).join(UI_EN[k]);
    }
    return out;
}
/** showMessage 的统一包装：英文界面把中文提示翻成英文，中文界面原样。 */
function msg(text, dur, type) {
    const s = trText(text);
    try { return showMessage(s, dur, type); } catch (e) { return s; }
}
/** 面板内文本节点 / title / aria-label / placeholder 翻译，并跟随后续动态更新。 */
function trDom(root) {
    if (!uiIsEn() || !root || typeof document === "undefined") return;
    const fixText = (n) => {
        const v = trText(n.nodeValue);
        if (v !== n.nodeValue) n.nodeValue = v;
    };
    const fixNode = (node) => {
        if (node.nodeType === 3) { fixText(node); return; }
        if (node.nodeType !== 1) return;
        const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) fixText(n);
        try {
            node.querySelectorAll("[title],[aria-label],[placeholder]").forEach((el) => {
                ["title", "aria-label", "placeholder"].forEach((a) => {
                    const v = el.getAttribute(a);
                    if (v) el.setAttribute(a, trText(v));
                });
            });
        } catch (e) { /* 忽略 */ }
    };
    fixNode(root);
    try {
        new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type === "characterData") fixText(m.target);
                else if (m.type === "childList") m.addedNodes.forEach(fixNode);
            }
        }).observe(root, { subtree: true, childList: true, characterData: true });
    } catch (e) { /* 忽略 */ }
}

/* 真机验证钩子（只读，不参与逻辑）：便于在渲染进程里核对语言判定与翻译结果。 */
try {
    globalThis.__docNumI18n = {
        trText: trText, uiIsEn: uiIsEn, count: UI_KEYS.length,
    };
} catch (e) { /* 忽略 */ }
