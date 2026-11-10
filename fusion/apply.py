# -*- coding: utf-8 -*-
"""对 build.py 输入的基线 index.js 文本应用融合补丁，返回融合后文本。"""
import os, runpy

def apply_fusion(s, core, methods, version):
    g = runpy.run_path(os.path.join(os.path.dirname(__file__), "apply_core.py"),
                      init_globals={"s": s, "core": core, "methods": methods, "version": version})
    return g["s"]
