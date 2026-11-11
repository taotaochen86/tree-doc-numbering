# -*- coding: utf-8 -*-
"""对 build.py 输入的基线 index.js 文本应用融合补丁，返回融合后文本。"""
import os, runpy

HERE = os.path.dirname(os.path.abspath(__file__))

def apply_fusion(s, core, methods, version):
    # v1.1.1 融合层（原样保留）
    g = runpy.run_path(os.path.join(HERE, "apply_core.py"),
                       init_globals={"s": s, "core": core, "methods": methods, "version": version})
    s = g["s"]
    # v1.1.2 B 方案：文档树块属性精确剥离（独立补丁步，锚点逐处断言）
    b = runpy.run_path(os.path.join(HERE, "apply_b_core.py"),
                       init_globals={"s": s, "core": core, "methods": methods, "version": version})
    s = b["s"]
    # v1.2.0：插件状态收进唯一 JSON 属性（独立补丁步，锚点逐处断言）
    a = runpy.run_path(os.path.join(HERE, "apply_attr_core.py"),
                       init_globals={"s": s, "core": core, "methods": methods, "version": version})
    s = a["s"]
    # v1.2.1：文档树层级上限 5 -> 7（独立补丁步，锚点逐处断言）
    l = runpy.run_path(os.path.join(HERE, "apply_level_core.py"),
                       init_globals={"s": s, "core": core, "methods": methods, "version": version})
    return l["s"]
