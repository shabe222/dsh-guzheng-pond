# -*- coding: utf-8 -*-
"""引文核对 v2（_audit.py 的补充，不改动 _audit.py）。

_audit.py 的判据是 `norm(引文)[:12] in corpus`（严格子串），对以下三种情形必然误报
「找不到」：① 引文繁体、_raw 底本简体；② 长引文带「……」时前 12 字跨了省略号；
③ 只看前 12 字，也会把「撞到别的书」当成命中（假阳性）。

本脚本的判据：
  1. 去标点 → zhconv 简繁归一 → 异体归并（閒/閑→間、竝→並、旣→既…）
  2. 按「……」把长引文切段，逐段核对（省略号两边本来就允许不连续）
  3. 对每段求「最长连续命中长度」+「与底本对齐区间的相似度」
  4. 单段最长连续命中 < 15 字才算可疑，交人工

用法：python -X utf8 _verify_citations.py            # 只打摘要
      python -X utf8 _verify_citations.py --table    # 打逐条 Markdown 表
依赖：pip install zhconv
"""
import os
import re
import sys
import glob
import difflib

try:
    import zhconv
except ImportError:  # pragma: no cover
    sys.exit("需要 zhconv：python -m pip install zhconv")

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "_raw")

PUNCT = re.compile(r"[\s，。、；：？！「」『』“”‘’（）《》〈〉…—·,.;:?!\"'()\[\]<>/\\|\-~～]+")
PARTICLES = set("之其者也而以於焉矣夫乎哉曰")
MODERN = ("工具", "标签", "听感", "句子", "版本", "问题", "音数", "旋律", "和弦", "用户",
          "检查项", "卡", "一句", "这段", "这句", "怎么", "为什么", "建议", "生成")
VARIANT = str.maketrans({"閒": "間", "閑": "間", "畧": "略", "敎": "教", "旣": "既",
                         "眞": "真", "衞": "衛", "竝": "並", "爲": "為", "歎": "嘆"})
SKIP_MD = ("INDEX.md", "digest.md", "_audit-report.md", "_audit-report-v2.md")


def canon(s):
    """去标点 + 繁转简 + 异体归并。"""
    return zhconv.convert(PUNCT.sub("", s), "zh-cn").translate(VARIANT)


def load_corpus():
    docs = []
    for p in sorted(glob.glob(os.path.join(RAW, "*"))):
        if os.path.isdir(p):
            continue
        ext = os.path.splitext(p)[1].lower()
        if ext not in (".txt", ".json", ".html"):
            continue
        try:
            raw = open(p, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        if ext == ".html":
            raw = re.sub(r"<script[\s\S]*?</script>", "", raw, flags=re.I)
            raw = re.sub(r"<style[\s\S]*?</style>", "", raw, flags=re.I)
            raw = re.sub(r"<[^>]+>", "", raw)
        elif ext == ".json":
            raw = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), raw)
            raw = re.sub(r'\\[nrt"]', " ", raw)
        docs.append((os.path.basename(p), canon(raw)))
    return docs


def longest_run(seg, docs):
    """seg 的最长连续子串在 docs 里的命中：(长度, 文件名, 位置, 全文)。"""
    n = len(seg)
    lo, hi, best = 1, n, None
    while lo <= hi:
        mid = (lo + hi) // 2
        found = None
        for i in range(0, n - mid + 1):
            w = seg[i:i + mid]
            for name, d in docs:
                pos = d.find(w)
                if pos >= 0:
                    found = (mid, name, pos, d)
                    break
            if found:
                break
        if found:
            best = found
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def check(seg, docs):
    hit = longest_run(seg, docs)
    if not hit:
        return (0, "", 0.0)
    L, name, pos, d = hit
    win = d[max(0, pos - len(seg) - 40): pos + len(seg) + 80]
    sm = difflib.SequenceMatcher(None, seg, win, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size > 0]
    if not blocks:
        return (L, name, 0.0)
    span = win[blocks[0].b: blocks[-1].b + blocks[-1].size]
    ratio = difflib.SequenceMatcher(None, seg, span, autojunk=False).ratio()
    return (L, name, ratio)


def looks_classical(s):
    if len(s) < 10:
        return False
    if any(w in s for w in MODERN):
        return False
    return sum(1 for ch in s if ch in PARTICLES) >= 2


def iter_quotes():
    qre = re.compile(r"「([^」]{8,300})」|“([^”]{8,300})”")
    for p in sorted(glob.glob(os.path.join(HERE, "*.md"))):
        name = os.path.basename(p)
        if name in SKIP_MD:
            continue
        text = open(p, encoding="utf-8").read()
        jx = text.find("## 校记")
        for m in qre.finditer(text):
            q = (m.group(1) or m.group(2) or "").strip()
            if not looks_classical(q):
                continue
            yield name, q, (jx >= 0 and m.start() > jx)


def main():
    docs = load_corpus()
    rows = []
    for name, q, in_jx in iter_quotes():
        if in_jx:            # 校记里用来说明讹字的片段，不是正文引文
            continue
        segs = [canon(s) for s in re.split(r"[…\.]{2,}|—{2,}", q)]
        segs = [s for s in segs if s]
        res = [check(s, docs) for s in segs]
        worst_L = min(r[0] for r in res)
        worst_r = min(r[2] for r in res)
        srcs = sorted({r[1] for r in res if r[1]})
        rows.append((name, q, worst_L, worst_r, srcs))

    bad = [r for r in rows if r[3] < 0.999]
    exact = len(rows) - len(bad)
    print("正文引文 %d 条；与底本对齐后相似度 = 1.000（逐字命中）：%d 条；有字面差异：%d 条"
          % (len(rows), exact, len(bad)))
    print("（短引文只要整段落在底本里也算命中；相似度 <1 的逐条列在下面，"
          "对应的讹字/异文说明见各文件文末「校记」）")
    if bad:
        print("\n有字面差异的条目：")
        for name, q, L, r, srcs in bad:
            print("  [%s] 相似度 %.3f，最长连续命中 %d 字：%s" % (name, r, L, q[:56]))
    if "--table" in sys.argv:
        print("\n| # | 引文首句 | 文件 | 最长连续命中 | 相似度 | 底本 |")
        print("|---|---|---|---|---|---|")
        for i, (name, q, L, r, srcs) in enumerate(rows, 1):
            print("| %d | %s… | %s | %d 字 | %.3f | %s |"
                  % (i, q[:20], name, L, r, ",".join(srcs[:2])))


if __name__ == "__main__":
    main()
