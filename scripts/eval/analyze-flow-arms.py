#!/usr/bin/env python3
"""Summarise a flow-arm run.

Reports latency and the retrieval DECISION separately, and never collapses them
into one score. A faster arm that answers worse is a loss, and an arm that
never searches would top a latency table while being useless — so the two axes
stay visible side by side and quality is judged separately (see
judge-flow-arms.py).

Decision accuracy is split by direction on purpose. The two errors are not
symmetric: over-searching costs latency and some accuracy, while
under-searching produces confidently stale answers a user cannot detect
(measured at ~47 points on time-sensitive questions in the FreshQA work). An
arm that wins overall accuracy by under-searching is not a better arm.

Usage: analyze-flow-arms.py results/flow-arms-run1.jsonl
"""
import json, statistics as st, sys
from collections import defaultdict
from pathlib import Path


def med(xs):
    return st.median(xs) if xs else 0.0


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else
                "scripts/eval/results/flow-arms-run1.jsonl")
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    if not rows:
        print("no rows"); return

    arms, order = defaultdict(list), []
    for r in rows:
        if r["arm"] not in arms:
            order.append(r["arm"])
        arms[r["arm"]].append(r)

    n_probes = max(len(v) for v in arms.values())
    print(f"{path.name}   {len(rows)} turns / {len(order)} arms / up to {n_probes} probes each\n")

    print("LATENCY AND MECHANICS")
    print("  %-13s %7s %7s %7s %6s %6s %7s" %
          ("arm", "median", "mean", "max", "steps", "tools", "errors"))
    for a in order:
        rs = arms[a]
        lat = [r["total_s"] for r in rs if r["total_s"]]
        errs = sum(1 for r in rs if r["http"] != 200 or not r["answer_chars"])
        print("  %-13s %6.1fs %6.1fs %6.1fs %6.1f %6.1f %7s" % (
            a, med(lat), st.mean(lat) if lat else 0, max(lat) if lat else 0,
            st.mean([r["steps"] or 0 for r in rs]),
            st.mean([r["tool_calls"] or 0 for r in rs]), errs))

    print("\nRETRIEVAL DECISION  (expectSearch labels are my judgement, not ground truth)")
    print("  %-13s %9s %14s %16s" %
          ("arm", "correct", "over-searched", "UNDER-searched"))
    for a in order:
        rs = arms[a]
        ok = sum(1 for r in rs if r["decision_correct"])
        over = sum(1 for r in rs if r["searched"] and not r["expectSearch"])
        under = sum(1 for r in rs if not r["searched"] and r["expectSearch"])
        print("  %-13s %4d/%-4d %8d      %10d %s" % (
            a, ok, len(rs), over, under,
            "  <-- costs stale answers" if under else ""))

    print("\nSPLIT BY QUESTION TYPE (median seconds)")
    print("  %-13s %22s %22s" % ("arm", "should NOT search", "should search"))
    for a in order:
        rs = arms[a]
        no = [r["total_s"] for r in rs if not r["expectSearch"] and r["total_s"]]
        yes = [r["total_s"] for r in rs if r["expectSearch"] and r["total_s"]]
        print("  %-13s %21.1fs %21.1fs" % (a, med(no), med(yes)))

    print("\nOUTPUT CONTRACT")
    print("  %-13s %10s %12s %14s" % ("arm", "answered", "## heading", "mustMention"))
    for a in order:
        rs = arms[a]
        answered = sum(1 for r in rs if r["answer_chars"] > 0)
        heads = sum(1 for r in rs if r.get("has_heading"))
        mm = [r for r in rs if r.get("mustMention_ok") is not None]
        mm_ok = sum(1 for r in mm if r["mustMention_ok"])
        print("  %-13s %5d/%-4d %7d/%-4d %9s" % (
            a, answered, len(rs), heads, len(rs),
            f"{mm_ok}/{len(mm)}" if mm else "-"))

    # Per-probe latency, so a single pathological question is visible rather
    # than hidden inside a median.
    print("\nPER-PROBE SECONDS")
    probes = sorted({r["probe"] for r in rows})
    print("  probe  " + "".join("%-13s" % a[:12] for a in order))
    for p in probes:
        line = "  %-6s " % p
        for a in order:
            r = next((x for x in arms[a] if x["probe"] == p), None)
            line += "%-13s" % (f"{r['total_s']:.0f}s{'*' if not r['decision_correct'] else ''}"
                               if r else "-")
        print(line)
    print("  (* = retrieval decision disagreed with the label)")


if __name__ == "__main__":
    main()
