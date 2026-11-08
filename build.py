#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 src/numbering.js + src/body_numbering.js + src/plugin.js 拼成思源加载器要的单文件 index.js。

用法：python build.py [--no-zip]
产出：index.js、build-info.json（源码/产物 md5，供 test/check_deploy.py 核对）、
      package.zip（根层五文件：plugin.json / index.js / README.md / README_en.md / icon.png）
改代码后必须重跑本脚本；index.js 与 package.zip 都是生成物，不要手改。
"""
import os
import re
import sys
import json
import hashlib
import zipfile
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def md5(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def main():
    numbering = read(os.path.join(SRC, "numbering.js"))
    body = read(os.path.join(SRC, "body_numbering.js"))
    plugin = read(os.path.join(SRC, "plugin.js"))
    pj = json.loads(read(os.path.join(ROOT, "plugin.json")))
    readme = read(os.path.join(ROOT, "README.md"))

    version = pj["version"]
    if "v" + version not in readme:
        raise RuntimeError("README.md 里没有 v%s，版本号没对齐" % version)
    # 源码里的 PLUGIN_VERSION 是 diagnose() 对外报的版本，必须和 plugin.json 一致。
    mver = re.search(r'const PLUGIN_VERSION = "([^"]+)"', plugin)
    if not mver:
        raise RuntimeError("src/plugin.js 里找不到 PLUGIN_VERSION")
    if mver.group(1) != version:
        raise RuntimeError("版本不一致：plugin.json=%s / src/plugin.js PLUGIN_VERSION=%s"
                           % (version, mver.group(1)))

    header = (
        "/* 子文档自动编号 v%s · 本文件由 build.py 生成，请勿手改\n"
        " * 源码：src/numbering.js（编号核心）+ src/plugin.js（插件主体）\n"
        " * 加载器用 window.eval 包 CommonJS → 只能写 module.exports = class extends Plugin\n"
        " */\n\n" % version
    )
    out = header + numbering.rstrip() + "\n\n" + body.rstrip() + "\n\n" + plugin.lstrip()

    # 语法自检（Node 在才跑；不装 Node 也不阻断生成）
    tmp = os.path.join(ROOT, ".build-syntax.js")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(out)
    import subprocess
    try:
        subprocess.run(["node", "--check", tmp], check=True, capture_output=True, text=True)
        syntax = "node --check OK"
    except FileNotFoundError:
        syntax = "Node 不在，跳过语法检查"
    except subprocess.CalledProcessError as e:
        os.remove(tmp)
        raise RuntimeError("拼出来的 index.js 语法错：" + (e.stderr or "")[:600])
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    with open(os.path.join(ROOT, "index.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(out)

    # 打包：zip 根层必须是这 4 个文件（思源安装要求），顺序固定便于比对
    zpath = os.path.join(ROOT, "package.zip")
    zmd5, zsize = None, None
    if "--no-zip" not in sys.argv:
        names = ["plugin.json", "index.js", "README.md", "README_en.md", "icon.png"]
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for n in names:
                z.write(os.path.join(ROOT, n), n)
        with open(zpath, "rb") as f:
            zmd5 = hashlib.md5(f.read()).hexdigest()
        zsize = os.path.getsize(zpath)

    info = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "version": version,
        "syntax": syntax,
        "src/numbering.js": md5(numbering),
        "src/body_numbering.js": md5(body),
        "src/plugin.js": md5(plugin),
        "index.js": md5(out),
    }
    if zmd5:
        info["package.zip"] = zmd5
        info["package.zip_size"] = zsize
    with open(os.path.join(ROOT, "build-info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    if zmd5:
        print("已生成 package.zip（%d 字节，md5 %s）" % (zsize, zmd5))
    print("已生成 index.js（%d 字节），%s" % (len(out.encode("utf-8")), syntax))
    print("版本", version, "| index.js md5", info["index.js"])


if __name__ == "__main__":
    main()
