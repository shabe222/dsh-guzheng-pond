# -*- coding: utf-8 -*-
"""引文审计 v2：只审「像古文」的引文（含虚词、无现代词），逐条去 _raw 里找。

只报事实：找到 / 找不到。找不到的进清单，人工再看。
"""
import os
import re
import glob

try:
    import zhconv  # 繁简归一；不做这一步会把简体原文误判成「找不到」
except ImportError:  # pragma: no cover
    zhconv = None

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "_raw")

PUNCT = re.compile(r"[\s，。、；：？！「」『』“”‘’（）《》〈〉…—·,.;:?!\"'()\[\]<>/\\|-]+")
PARTICLES = set("之其者也而以於焉矣夫乎哉曰")
MODERN = ("工具", "标签", "听感", "句子", "版本", "问题", "音数", "旋律", "和弦", "用户",
          "检查项", "卡", "一句", "这段", "这句", "怎么", "为什么", "建议", "生成")


def norm(s):
    s = PUNCT.sub("", s)
    if zhconv is not None:
        s = zhconv.convert(s, "zh-cn")
    return s


def looks_classical(s):
    if len(s) < 10:
        return False
    if any(w in s for w in MODERN):
        return False
    hits = sum(1 for ch in s if ch in PARTICLES)
    return hits >= 2


def load_corpus():
    chunks = []
    for p in glob.glob(os.path.join(RAW, "*")):
        if os.path.isdir(p) or os.path.splitext(p)[1].lower() not in (".txt", ".json", ".html"):
            continue
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                raw = fh.read()
                raw = re.sub(r'<script[\s\S]*?</script>', '', raw, flags=re.I)
                raw = re.sub(r'<style[\s\S]*?</style>', '', raw, flags=re.I)
                raw = re.sub(r'<[^>]+>', '', raw)
                chunks.append(norm(raw))
        except OSError:
            pass
    return "\n".join(chunks)


def main():
    corpus = load_corpus()
    quote_re = re.compile(r"「([^」]{8,300})」|“([^”]{8,300})”")
    total = found = 0
    misses = []
    per_file = {}
    for p in sorted(glob.glob(os.path.join(HERE, "*.md"))):
        name = os.path.basename(p)
        if name in ("INDEX.md", "digest.md"):
            continue
        text = open(p, encoding="utf-8").read()
        for m in quote_re.finditer(text):
            q = (m.group(1) or m.group(2) or "").strip()
            if not looks_classical(q):
                continue
            nq = norm(q)
            total += 1
            ok = nq[:12] in corpus
            per_file.setdefault(name, [0, 0])
            per_file[name][1] += 1
            if ok:
                found += 1
                per_file[name][0] += 1
            else:
                misses.append((name, q[:70]))
    print("古文引文 %d 条，原始档能找到 %d 条，找不到 %d 条（%.0f%%）" % (
        total, found, len(misses), (len(misses) / total * 100) if total else 0))
    print("\n按文件：")
    for name, (ok, tot) in sorted(per_file.items()):
        flag = "" if ok == tot else "  ← %d/%d" % (ok, tot)
        print("  %-28s %d/%d%s" % (name, ok, tot, flag))
    print("\n找不到的引文：")
    for name, q in misses:
        print("  [%s] %s" % (name, q))


if __name__ == "__main__":
    main()
