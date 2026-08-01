#!/usr/bin/env python3
"""Summarise a browser-driven staging-vs-lab run, SPLIT BY TURN TYPE.

WHY THE SPLIT IS THE WHOLE POINT. Pooling every turn produces a single median
that means nothing here, because the two architectures differ most on exactly
the axis that varies between turns: whether the turn needs the web. On a
settled-knowledge turn the pipeline skips retrieval entirely and wins by 7x; on
a serial current-events thread it re-retrieves from scratch each turn where the
loop reuses what it already has. A pooled median is just a weighted average of
those two regimes, and it moves with the question mix rather than with the
system.

Turn type is taken from what the instances DID (did either side retrieve?),
not from what the classifier said, because the classifier's decision is one of
the things under test.

SPEED IS NOT SCORED HERE. An architecture that answers faster by answering
thinner would win every table below. Grounding and answer size are reported
alongside so a speed win that comes with a source collapse is visible, and the
quality verdict belongs to judge-flow-arms.py on the emitted pairs.

Usage:
  analyze-pairs.py scripts/eval/results/browser-pairs.jsonl
"""
import argparse, json, statistics as st
from pathlib import Path


def med(xs):
    return round(st.median(xs), 1) if xs else 0.0


def block(title, rows):
    if not rows:
        print(f"\n{title}: (none)")
        return
    s_t = [r["staging"].get("total_s", 0) for r in rows]
    l_t = [r["lab"].get("total_s", 0) for r in rows]
    deltas = [l - s for s, l in zip(s_t, l_t)]
    lab_faster = sum(1 for d in deltas if d < 0)
    s_src = [r["staging"].get("sources", 0) for r in rows]
    l_src = [r["lab"].get("sources", 0) for r in rows]
    s_ch = [r["staging"].get("chars", 0) for r in rows]
    l_ch = [r["lab"].get("chars", 0) for r in rows]

    def cites(side):
        return [(r[side].get("cite_anchored", 0) or 0) + (r[side].get("cite_bare", 0) or 0)
                for r in rows]

    print(f"\n{title}  (n={len(rows)})")
    print(f"  latency median      staging {med(s_t):7.1f}s   lab {med(l_t):7.1f}s"
          f"   median delta {med(deltas):+.1f}s")
    print(f"  lab faster on       {lab_faster}/{len(rows)} turns")
    if med(l_t) > 0:
        print(f"  median speedup      x{round(med(s_t)/max(med(l_t), 0.1), 2)}")
    print(f"  sources median      staging {med(s_src):7.1f}    lab {med(l_src):7.1f}"
          f"   (turns with any: {sum(1 for x in s_src if x)}/{len(rows)}"
          f" vs {sum(1 for x in l_src if x)}/{len(rows)})")
    print(f"  citations median    staging {med(cites('staging')):7.1f}    lab {med(cites('lab')):7.1f}")
    print(f"  answer chars median staging {med(s_ch):7.1f}    lab {med(l_ch):7.1f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.path).read_text().splitlines() if l.strip()]
    # A turn is only comparable if BOTH sides produced timing. An in-flight or
    # aborted turn is reported separately rather than counted as 0.0s, which
    # would silently flatter whichever side failed.
    usable = [r for r in rows
              if r["staging"].get("total_s") and r["lab"].get("total_s")]
    broken = [r for r in rows if r not in usable]

    print(f"turns: {len(rows)} total, {len(usable)} comparable, {len(broken)} incomplete")

    # Split on what happened, not on what the classifier decided.
    research = [r for r in usable
                if r["staging"].get("sources", 0) or r["lab"].get("sources", 0)]
    settled = [r for r in usable if r not in research]

    block("ALL COMPARABLE TURNS", usable)
    block("RESEARCH TURNS (either side retrieved)", research)
    block("SETTLED TURNS (neither side retrieved)", settled)

    # The asymmetric case the pooled table hides: one side searched and the
    # other did not. This is where information loss would show up.
    only_staging = [r for r in usable
                    if r["staging"].get("sources", 0) and not r["lab"].get("sources", 0)]
    only_lab = [r for r in usable
                if r["lab"].get("sources", 0) and not r["staging"].get("sources", 0)]
    print(f"\nASYMMETRIC RETRIEVAL")
    print(f"  staging searched, lab did NOT: {len(only_staging)} turns")
    for r in only_staging:
        print(f"    c{r['chat']}t{r['turn']}  staging {r['staging']['sources']:>3} src"
              f" / {r['staging']['chars']:>5} ch   lab 0 src / {r['lab']['chars']:>5} ch"
              f"   {r['staging']['total_s']:>6.1f}s vs {r['lab']['total_s']:>5.1f}s")
    print(f"  lab searched, staging did NOT: {len(only_lab)} turns")
    for r in only_lab:
        print(f"    c{r['chat']}t{r['turn']}  lab {r['lab']['sources']:>3} src"
              f" / {r['lab']['chars']:>5} ch   staging 0 src / {r['staging']['chars']:>5} ch")

    print(f"\nFAILURES")
    for side in ("staging", "lab"):
        empt = [r for r in rows if r[side].get("empty")]
        abort = [r for r in rows if r[side].get("aborted")]
        stall = [r for r in rows if r[side].get("stall_retries")]
        print(f"  {side:8} empty {len(empt)}  aborted {len(abort)}  stall-retried {len(stall)}")
        for r in empt:
            print(f"    EMPTY c{r['chat']}t{r['turn']}  {r[side].get('total_s')}s"
                  f" steps={r[side].get('steps')} prose={r[side].get('wrote_prose')}")

    print(f"\nPER CHAT (total wall seconds)")
    chats = sorted({r["chat"] for r in usable})
    for c in chats:
        rs = [r for r in usable if r["chat"] == c]
        s = sum(r["staging"]["total_s"] for r in rs)
        l = sum(r["lab"]["total_s"] for r in rs)
        print(f"  chat {c:>2} ({len(rs)} turns)  staging {s:8.1f}s   lab {l:8.1f}s"
              f"   x{round(s/max(l,0.1),2)}")


if __name__ == "__main__":
    main()
