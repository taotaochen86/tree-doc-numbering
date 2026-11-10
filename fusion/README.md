# fusion/ —— 文档合并与拆分融合层（v1.1.1）

- `baseline-index.v0.9.5.js`：v0.9.5 的 `index.js` 基线（思源端已验证的纯编号版）。
- `fusion-core.js`：纯函数层（拆/合、菜单、层级升降级），插入 `class` 之前。
- `fusion-methods.js`：插件方法层（二级菜单、四个操作、编号激发、块属性隔离、批量写入）。
- `apply.py`：对基线文本做可复现替换，输出融合版。每处替换都有断言，锚点不匹配即报错。

`build.py` 读取基线 → 调用 `apply.py` → 写 `index.js` / `package.zip` / `build-info.json`。
**不要手改 `index.js` / `package.zip`。**

注意：仓库 `src/` 是 v0.9.4 源码快照，与 v0.9.5 基线不完全同步（例如 `stripNumber` 实现有差异），
因此构建不直接拼接 `src/`，而以基线为准；`build-info.json` 里仍记录 `src/` 的 md5 供追溯。
- `apply_core.py`：替换逻辑原文（不缩进，保证 JS 锚点逐字匹配）；`apply.py` 注入参数后执行它。

`apply_core.py` 的 G 步把基线里的 `PLUGIN_VERSION` 对齐 `plugin.json`，改版本号只需改 `plugin.json`。
