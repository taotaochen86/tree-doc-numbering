# fusion/ —— 可复现融合构建层（v1.2.2）

`build.py` 以 `baseline-index.v0.9.5.js` 为基线，按固定顺序应用五步带断言的补丁，生成 `index.js` / `package.zip` / `build-info.json`。**不要手改生成物**；改功能请改对应补丁或纯函数层。

## 基线

- `baseline-index.v0.9.5.js`：v0.9.5 的 `index.js` 基线（思源端已验证）。

## 纯函数层（拼在 class 之前）

- `attrs.js`：单属性层 `MSTdnAttrs` —— 唯一 JSON 属性 `custom-doc-num-meta` 的 `parse` / `fromIal` / `compact` / `merge` / `toNode`。
- `tree-prefix.js`：文档树「编号文本 / 用户文本」隔离层 `MSTreePrefix` —— `isProtected` / `ownDecor` / `peel` / `parseOwn`。
- `fusion-core.js`：拆 / 合、菜单、层级升降级纯函数。
- `fusion-methods.js`：插件方法层（二级菜单、四个操作、编号激发、块属性隔离、批量写入）。

## 补丁顺序（`apply.py`）

1. `apply_core.py`：融合层（纯函数、插件方法、日期保护、`preStripped` 短路、批量写入、范围隔离、菜单包装、版本常量对齐）。
2. `apply_b_core.py`：文档树块属性精确剥离。
3. `apply_attr_core.py`：插件状态收进唯一 JSON 属性。
4. `apply_level_core.py`：文档树层级上限 5 → 7（正文内容标题仍 5 级）。
5. `apply_idem_core.py`：正文编号幂等判定改用剥离前原文，消除「连续 3 轮不同结果」误报。

每处替换都断言锚点命中次数，锚点不匹配即报错，避免静默漏改。补丁文件请勿缩进（保证 JS 锚点逐字匹配）。`apply_core.py` 的 G 步把基线里的 `PLUGIN_VERSION` 对齐 `plugin.json`，改版本号只需改 `plugin.json`。

## 注意

仓库 `src/` 是 v0.9.4 源码快照，与 v0.9.5 基线不完全同步（例如 `stripNumber` 实现有差异），因此构建不直接拼接 `src/`，而以基线为准；`build-info.json` 里仍记录 `src/` 的 md5 供追溯。离线单测 `test/level7_unit.js`、`test/body_idem_unit.js` 直接加载生成物 `index.js` 的纯函数层，避免只测到历史快照。
