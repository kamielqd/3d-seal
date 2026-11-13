#!/usr/bin/env python3
"""构建期生成「简 -> 繁」映射表（只保留常用字范围，运行时只加载产出的 JSON）。

为什么需要它：
    全字库说文解字字型按繁体/旧字形码位编码，用户输入简体时要先映射到繁体再取字形。
    只做「构建期一次性生成」，把结果落成一张小 JSON 表；前端仅 import 这张表，
    绝不把 opencc / zhconv 之类的整包打进 bundle。

用法（构建期，需一次性安装工具：pip install zhconv；运行时不需要）：
    python scripts/gen-simp-trad.py

产物：
    src/layout/data/simp-trad.json  形如 {"发":"發","国":"國", ...}
范围：
    GB2312 一级汉字 3755（≈ 常用 3500）中「简体 != 繁体」的字，单字映射。
"""
import json
import gzip
import os

try:
    import zhconv
except ImportError as e:  # pragma: no cover
    raise SystemExit("需要构建期工具 zhconv：pip install zhconv（仅构建期，运行时不需要）") from e


def gb2312_level1():
    """GB2312 一级汉字（0xB0A1-0xD7F9，3755 字，≈ 常用 3500）。"""
    out = []
    for b1 in range(0xB0, 0xD8):
        for b2 in range(0xA1, 0xFF):
            try:
                out.append(bytes([b1, b2]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def build_map():
    mp = {}
    for c in gb2312_level1():
        t = zhconv.convert(c, "zh-hant")
        if t != c and len(t) == 1:
            mp[c] = t
    return mp


def main():
    mp = build_map()
    here = os.path.dirname(os.path.abspath(__file__))
    outdir = os.path.normpath(os.path.join(here, "..", "src", "layout", "data"))
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, "simp-trad.json")
    js = json.dumps(mp, ensure_ascii=False, separators=(",", ":"))
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(js)
    raw = len(js.encode("utf-8"))
    gz = len(gzip.compress(js.encode("utf-8"), 9))
    print(f"wrote {path}")
    print(f"entries={len(mp)}  raw={raw}B ({raw/1024:.1f}KB)  gzip={gz}B ({gz/1024:.1f}KB)")


if __name__ == "__main__":
    main()
