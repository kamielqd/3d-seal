#!/usr/bin/env python3
"""构建期：从「全字库说文解字」生成篆书分块子集 TTF + manifest + 全字体覆盖率表。

产物：
  public/fonts/shuowen/shuowen-block1.ttf   (高频 ~1000 字，篆书模式首块)
  public/fonts/shuowen/shuowen-block2.ttf   (常用 3500 内其余 ~1596 字，按需)
  public/fonts/shuowen/manifest.json        (shards: id/file/bytes/count/ranges)
  public/fonts/shuowen/SOURCE.txt           (出处 + OGDL 授权说明)
  src/layout/data/coverage.json             (各内置字体可渲染字符集，供 checkMissing 用)

关键：说文按繁体/旧字形码位编码。这里把「简体字码位」作为别名写进分块 TTF 的 cmap，
      指向对应小篆字形，于是运行时 charToGlyph(简体) 直接命中，无需再查简繁表。

构建期工具：fontTools + zhconv（pip install fonttools brotli zhconv），不进入前端 bundle。
用法：SHUOWEN_TTF=/path/ebas927.ttf python scripts/gen-font-data.py
"""
import json
import os

from fontTools import subset
from fontTools.ttLib import TTFont
import zhconv

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SRC = os.environ.get("SHUOWEN_TTF") or os.path.join(os.environ.get("TEMP", ""), "shuowen", "ebas927.ttf")
DATA = os.path.join(REPO, "src", "layout", "data")
FONTS = os.path.join(REPO, "public", "fonts")
OUT = os.path.join(FONTS, "shuowen")
os.makedirs(OUT, exist_ok=True)
os.makedirs(DATA, exist_ok=True)

ASCII = set(range(0x20, 0x7F))
PUNCT = set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFF66))


def read_chars(name: str) -> str:
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return f.read().strip()


def is_unicode_table(t) -> bool:
    return t.platformID == 0 or (t.platformID == 3 and t.platEncID in (1, 10))


def build_block(chars: str, out_path: str):
    cmap = TTFont(SRC).getBestCmap()
    targets = set()
    alias = {}  # simplified char -> target codepoint in font
    for c in chars:
        cp = ord(c)
        if cp in cmap:
            targets.add(cp)
            alias[c] = cp
            continue
        for ch in zhconv.convert(c, "zh-hant"):
            t = ord(ch)
            if t in cmap:
                targets.add(t)
                alias[c] = t
                break
    uni = sorted(targets | ASCII | PUNCT)

    f = TTFont(SRC)
    s = subset.Subsetter(options=subset.Options())
    s.populate(unicodes=uni)
    s.subset(f)
    cm2 = f.getBestCmap()

    # 简体码位 -> 同一小篆字形（别名）
    for c, tcp in alias.items():
        gname = cm2.get(tcp)
        if not gname:
            continue
        for table in f["cmap"].tables:
            if is_unicode_table(table):
                try:
                    table.cmap[ord(c)] = gname
                except Exception:
                    pass
    f.save(out_path)
    return len(alias), os.path.getsize(out_path)


def ranges_of(chars: str):
    cps = sorted({ord(c) for c in chars})
    rs = []
    for cp in cps:
        if rs and cp == rs[-1][1] + 1:
            rs[-1][1] = cp
        else:
            rs.append([cp, cp])
    return rs


def flat_ranges(chars: str):
    """扁平化区间数组 [s0,e0,s1,e1,...]，比嵌套 JSON 小很多。"""
    return [x for pair in ranges_of(chars) for x in pair]


def cmap_chars(paths):
    cs = set()
    for p in paths:
        for cp in TTFont(p).getBestCmap().keys():
            if 0x20 <= cp < 0x110000 and cp != 0x7F and not (0xD800 <= cp <= 0xDFFF):
                cs.add(chr(cp))
    return "".join(sorted(cs))


def gb2312_level1():
    out = []
    for b1 in range(0xB0, 0xD8):
        for b2 in range(0xA1, 0xFF):
            try:
                out.append(bytes([b1, b2]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return out


def build_simplified_subset(src, chars, out_path):
    """把任意字体按给定简体字集 + ASCII + 标点做子集（用于思源黑体等单文件字体）。"""
    cmap = TTFont(src).getBestCmap()
    targets = {ord(c) for c in chars if ord(c) in cmap}
    uni = sorted(targets | ASCII | PUNCT)
    f = TTFont(src)
    s = subset.Subsetter(options=subset.Options())
    s.populate(unicodes=uni)
    s.subset(f)
    f.save(out_path)
    return len(targets), os.path.getsize(out_path)


def main():
    b1 = read_chars("shuowen-block1.txt")
    b2 = read_chars("shuowen-block2.txt")
    p1 = os.path.join(OUT, "shuowen-block1.ttf")
    p2 = os.path.join(OUT, "shuowen-block2.ttf")
    n1, sz1 = build_block(b1, p1)
    n2, sz2 = build_block(b2, p2)

    # 思源黑体（可选）：SOURCE_HAN_SANS 指向 SourceHanSansCN-Regular.otf，按 GB2312 一级 3755 子集化
    shs_out = os.path.join(FONTS, "source-han-sans", "source-han-sans-subset.otf")
    shs_src = os.environ.get("SOURCE_HAN_SANS")
    if shs_src and os.path.exists(shs_src):
        os.makedirs(os.path.dirname(shs_out), exist_ok=True)
        shs_n, shs_sz = build_simplified_subset(shs_src, gb2312_level1(), shs_out)
        print(f"source-han-sans: {shs_n} chars -> {shs_sz} bytes ({shs_sz/1024/1024:.2f}MB)")

    units = TTFont(SRC)["head"].unitsPerEm
    manifest = {
        "fontId": "shuowen",
        "name": "说文解字（小篆）",
        "unitsPerEm": units,
        "license": "OGDL-1.0",
        "licenseUrl": "https://data.gov.tw/license",
        "rangesFormat": "flat [start,end,start,end,...] BMP codepoints",
        "shards": [
            {"id": "block1", "file": "shuowen-block1.ttf", "bytes": sz1, "count": n1, "ranges": flat_ranges(b1)},
            {"id": "block2", "file": "shuowen-block2.ttf", "bytes": sz2, "count": n2, "ranges": flat_ranges(b2)},
        ],
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8", newline="") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    source_txt = (
        "全字库说文解字 TrueType 字型（ebas927.ttf）\n"
        "来源：台湾 全字库 CNS11643  https://www.cns11643.gov.tw/\n"
        "授权：政府资料开放授权条款 第1版（OGDL-1.0）——可商用、可散布/公开传输，需署名；\n"
        "      授权全文 https://data.gov.tw/license\n"
        "说明：本目录为构建期按字频分块的子集（shuowen-block1/2.ttf），仅供本项目网页按需嵌入；\n"
        "      已将简体字码位作为别名映射到对应小篆字形，便于简体输入直接取轮廓。\n"
        "      字型仅收《说文》字形 6721 字，未收的后起字/现代字无篆形。\n"
    )
    with open(os.path.join(OUT, "SOURCE.txt"), "w", encoding="utf-8") as f:
        f.write(source_txt)

    coverage = {
        "smiley-sans": cmap_chars([os.path.join(FONTS, "smiley-sans", "smiley-sans-subset.ttf")]),
        "lxgw-wenkai": cmap_chars([os.path.join(FONTS, "lxgw-wenkai", "lxgw-wenkai-subset.ttf")]),
        "lxgw-seal": cmap_chars([os.path.join(FONTS, "lxgw-seal", "lxgw-seal.ttf")]),
        "shuowen": cmap_chars([p1, p2]),
    }
    if os.path.exists(shs_out):
        coverage["source-han-sans"] = cmap_chars([shs_out])
    cov_path = os.path.join(DATA, "coverage.json")
    with open(cov_path, "w", encoding="utf-8", newline="") as f:
        json.dump(coverage, f, ensure_ascii=False, separators=(",", ":"))

    # 分片 ranges 索引（前端按需选分片用；扁平 [s,e,s,e,...]）
    shard_json = {
        "shuowen": {
            "shards": [
                {"id": "block1", "ranges": flat_ranges(b1)},
                {"id": "block2", "ranges": flat_ranges(b2)},
            ]
        }
    }
    sj_path = os.path.join(DATA, "font-shards.json")
    with open(sj_path, "w", encoding="utf-8", newline="") as f:
        json.dump(shard_json, f, ensure_ascii=False, separators=(",", ":"))

    print(f"block1: {n1} chars -> {sz1} bytes ({sz1/1024/1024:.2f}MB)")
    print(f"block2: {n2} chars -> {sz2} bytes ({sz2/1024/1024:.2f}MB)")
    print("manifest:", os.path.join(OUT, "manifest.json"))
    print("coverage entries:", {k: len(v) for k, v in coverage.items()})
    print("coverage size:", os.path.getsize(cov_path), "bytes")


if __name__ == "__main__":
    main()
