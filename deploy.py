#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""部署到本机思源插件目录并重载界面（Q6 A 授权的夹外写入，仅此一处）。

用法：python deploy.py [--check]
    --check 只核对部署副本与源码 md5，只打印、不写任何文件、不重载
             （曾经会覆盖「部署记录.md」，把完整部署记录冲掉，2026-11-07 修）
"""
import os
import sys
import json
import shutil
import hashlib
import time
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "test"))
from live_lib import ROOT, PLUGIN_DIR, api, bridge_ready, bridge_eval  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
FILES = ["plugin.json", "index.js", "README.md", "icon.png"]
NAME = "tree-doc-numbering"


def md5(p):
    return hashlib.md5(p.read_bytes()).hexdigest()


def write_report(lines):
    (ROOT / "部署记录.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    lines = ["# 部署记录", "", "- 时间：" + datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
             "- 目标：`" + str(PLUGIN_DIR) + "`（由 `Path.home()` 推导，未写死）", ""]
    check_only = "--check" in sys.argv

    if check_only:
        lines += ["## 只核对，不写文件", ""]
        for f in FILES:
            a, b = ROOT / f, PLUGIN_DIR / f
            ok = b.exists() and md5(a) == md5(b)
            lines.append("- `%s`：%s（源码 %s / 部署副本 %s）" % (
                f, "一致" if ok else "**不一致或缺失**", md5(a), md5(b) if b.exists() else "—"))
        # --check 只打印：不写「部署记录.md」，避免把完整部署记录覆盖掉
        print("\n".join(lines[-len(FILES):]))
        return

    if not (PLUGIN_DIR.parent).exists():
        raise RuntimeError("思源插件目录不存在：" + str(PLUGIN_DIR.parent))

    if PLUGIN_DIR.exists():
        bak = ROOT / "backup" / ("plugins-before-" + datetime.now().strftime("%Y%m%d_%H%M%S"))
        bak.mkdir(parents=True, exist_ok=True)
        shutil.copytree(PLUGIN_DIR, bak / NAME)
        lines += ["- 已有同名插件，先备份到 `" + str(bak.relative_to(ROOT)) + "`", ""]
    else:
        PLUGIN_DIR.mkdir(parents=True, exist_ok=True)

    for f in FILES:
        shutil.copy2(ROOT / f, PLUGIN_DIR / f)

    lines += ["## 1. 覆盖文件 + md5 核对", "", "| 文件 | md5 | 副本一致 |", "|---|---|---|"]
    for f in FILES:
        ok = md5(ROOT / f) == md5(PLUGIN_DIR / f)
        lines.append("| `%s` | `%s` | %s |" % (f, md5(ROOT / f), "是" if ok else "**否**"))
        if not ok:
            raise RuntimeError("副本 md5 不一致：" + f)

    # 部署三步之二：重新启用（false → true 才会真正重载）
    r1 = api("/api/petal/setPetalEnabled", {"packageName": NAME, "enabled": False})
    r2 = api("/api/petal/setPetalEnabled", {"packageName": NAME, "enabled": True})
    lines += ["", "## 2. setPetalEnabled（入参是 packageName）", "",
              "```json", json.dumps({"false": r1, "true": r2}, ensure_ascii=False, indent=2)[:1200], "```", ""]
    if r2.get("code") != 0:
        lines.append("> ⚠️ 启用返回非 0：" + str(r2.get("msg")) + "（继续尝试 reloadUI）")

    # 部署三步之三：重载界面
    r3 = api("/api/ui/reloadUI", {})
    lines += ["## 3. reloadUI", "", "```json", json.dumps(r3, ensure_ascii=False, indent=2)[:600], "```", ""]

    # 等渲染进程回来，确认插件真的加载了（列表「已启用」≠ 代码是新的）
    ready, elapsed = False, 0
    for _ in range(30):
        time.sleep(1.5)
        elapsed += 1.5
        try:
            if bridge_ready():
                ready = True
                break
        except Exception:
            pass
    lines += ["## 4. 插件是否真的加载", "",
              "- 等待 %.1fs 后，渲染进程里 `window.__siyuanDocNumTest.runNumbering` = **%s**" % (
                  elapsed, "存在" if ready else "不存在"), ""]
    if ready:
        v = bridge_eval("window.__siyuanDocNumTest.constructor.name")
        lines += ["- 插件类：`" + str(v.get("result")) + "`", ""]
        idx = (ROOT / "index.js").read_text(encoding="utf-8")
        version = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))["version"]
        lines += ["- 部署副本 `index.js` 含 v%s 生成头：" % version + ("是" if "v" + version in idx else "**否**"),
                  "- 部署副本含 `renameDocByID`：" + ("是" if "renameDocByID" in idx else "**否**"), ""]
    else:
        lines += ["> ⚠️ 钩子没出现。可能：插件被标「损坏」、plugin.json 缺字段、或 reloadUI 尚未完成。",
                  "> 不要写成「部署成功」，需到「设置 → 集市 → 已下载」确认。", ""]

    write_report(lines)
    print("部署完成；插件加载 =", ready, "；记录：" + str(ROOT / "部署记录.md"))
    if not ready:
        sys.exit(2)


if __name__ == "__main__":
    main()
