#!/usr/bin/env python3
"""构建期生成「说文解字字型」按字频的高频分块清单，并报告各块 TTF 子集体积。

分块策略：
    block1 = 常用 3500 字（按字频前 3500）里、说文能渲染的最高频约 1000 字 -> 篆书模式首块
    block2 = 常用 3500 里其余说文能渲染的字                         -> 切换篆书后的懒加载块
    （常用 3500 以外、说文能渲染的字可再切第三块，按需加载）

「说文能渲染」= 简体字本身或其繁体映射落在字型 cmap 里。

用法：
    python scripts/gen-shuowen-blocks.py --ttf path/to/ebas927.ttf --freq path/to/hanzi_freq.txt
产物：
    src/layout/data/shuowen-block1.txt  （连续字串）
    src/layout/data/shuowen-block2.txt
"""
import argparse
import json
import os

from fontTools import subset
from fontTools.ttLib import TTFont

try:
    import zhconv
except ImportError as e:  # pragma: no cover
    raise SystemExit("需要构建期工具 zhconv：pip install zhconv（仅构建期）") from e


def load_freq(path):
    raw = open(path, encoding="utf-8", errors="ignore").read()
    if "var hanzipinlv" in raw:
        i = raw.index('var hanzipinlv = "') + len('var hanzipinlv = "')
        raw = raw[i:raw.index('"', i)]
    seen, order = set(), []
    for c in raw:
        if c not in seen:
            seen.add(c)
            order.append(c)
    return order


def load_cmap(ttf):
    f = TTFont(ttf)
    cmap = set()
    for t in f["cmap"].tables:
        cmap |= set(t.cmap.keys())
    return f, cmap


def target_of(c, cmap):
    if ord(c) in cmap:
        return ord(c)
    for ch in zhconv.convert(c, "zh-hant"):
        if ord(ch) in cmap:
            return ord(ch)
    return None


def measure(ttf, targets):
    base = set(range(0x20, 0x7F))
    punct = set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFF66))
    f = TTFont(ttf)
    s = subset.Subsetter(options=subset.Options())
    s.populate(unicodes=sorted(set(targets) | base | punct))
    s.subset(f)
    out = ttf + ".tmp.ttf"
    f.save(out)
    size = os.path.getsize(out)
    os.remove(out)
    return size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ttf", required=True)
    ap.add_argument("--freq", required=True)
    ap.add_argument("--top", type=int, default=3500)
    ap.add_argument("--head", type=int, default=1000)
    args = ap.parse_args()

    order = load_freq(args.freq)
    _, cmap = load_cmap(args.ttf)

    top = order[: args.top]
    cov = [c for c in top if target_of(c, cmap) is not None]
    block1 = cov[: args.head]
    block2 = cov[args.head :]

    here = os.path.dirname(os.path.abspath(__file__))
    outdir = os.path.normpath(os.path.join(here, "..", "src", "layout", "data"))
    os.makedirs(outdir, exist_ok=True)
    for name, chars in (("shuowen-block1.txt", block1), ("shuowen-block2.txt", block2)):
        with open(os.path.join(outdir, name), "w", encoding="utf-8", newline="") as f:
            f.write("".join(chars))

    m1 = measure(args.ttf, [target_of(c, cmap) for c in block1])
    m2 = measure(args.ttf, [target_of(c, cmap) for c in block2])
    report = {
        "top": len(top),
        "coveredInTop": len(cov),
        "missingInTop": len(top) - len(cov),
        "block1Count": len(block1),
        "block1TTFBytes": m1,
        "block2Count": len(block2),
        "block2TTFBytes": m2,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
