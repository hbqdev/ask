#!/usr/bin/env python3
"""Paired analysis of the pipeline-vs-loop architecture A/B.

PAIRED, NOT POOLED. The probe set spans questions whose retrieval cost differs
by an order of magnitude, so a mean over probes is dominated by whichever
probes happened to be slow rather than by the architecture. Every statistic
here is computed on the per-(probe, round) DIFFERENCE between the two arms,
which cancels the probe out.

The confound check is not optional and is printed first. Turn latency on this
stack is dominated by retrieval, and retrieval time depends on how saturated
the shared crawl4ai container is — a range of 0.3s to 141s has been measured.
If the two arms did not face comparable crawler conditions, the latency
comparison is void, and this says so rather than reporting a number that looks
like a result.

Usage:
  analyze-arch-ab.py scripts/eval/results/arch-ab.jsonl
"""
import argparse, json, statistics as st
from collections import defaultdict
from pathlib import Path


def med(xs):
    return st.median(xs) if xs else float("nan")


def fmt(x, unit=""):
    return "n/a" if x != x else f"{x:.1f}{unit}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.path).read_text().splitlines() if l.strip()]
    by = defaultdict(dict)  # (probe, round) -> arm -> row
    for r in rows:
        by[(r["probe"], r["round"])][r["arm"]] = r

    pairs = [(k, v["pipeline"], v["loop"]) for k, v in sorted(by.items())
             if "pipeline" in v and "loop" in v]
    if not pairs:
        raise SystemExit("no complete pipeline/loop pairs in this file")

    print(f"file={a.path}")
    print(f"rows={len(rows)}  complete pairs={len(pairs)}\n")

    # ---- confound check FIRST -------------------------------------------
    pipe_mem = [p["crawler_mem_pct"] for _, p, _ in pairs if p["crawler_mem_pct"] >= 0]
    loop_mem = [l["crawler_mem_pct"] for _, _, l in pairs if l["crawler_mem_pct"] >= 0]
    print("=== crawler conditions (the confound) ===")
    print(f"  crawl4ai memory at turn start — pipeline median {fmt(med(pipe_mem), '%')}, "
          f"loop median {fmt(med(loop_mem), '%')}")
    skew = abs(med(pipe_mem) - med(loop_mem)) if pipe_mem and loop_mem else float("nan")
    if skew == skew and skew > 15:
        print(f"  WARNING: {skew:.0f} point gap — the arms did NOT face comparable")
        print("  crawler conditions, so treat the latency comparison as void.")
    else:
        print(f"  gap {fmt(skew)} points — comparable, latency comparison stands.")

    # ---- latency, paired -------------------------------------------------
    d_total = [p["total_s"] - l["total_s"] for _, p, l in pairs
               if p["total_s"] and l["total_s"]]
    faster = sum(1 for d in d_total if d < 0)
    print("\n=== latency (paired, negative = pipeline faster) ===")
    print(f"  pipeline median {fmt(med([p['total_s'] for _, p, _ in pairs]), 's')}   "
          f"loop median {fmt(med([l['total_s'] for _, _, l in pairs]), 's')}")
    print(f"  median paired delta {fmt(med(d_total), 's')}")
    print(f"  pipeline faster on {faster}/{len(d_total)} pairs")
    if d_total:
        speedup = [l["total_s"] / p["total_s"] for _, p, l in pairs
                   if p["total_s"] > 0 and l["total_s"] > 0]
        print(f"  median speedup x{fmt(med(speedup))}")

    # ---- round trips -----------------------------------------------------
    print("\n=== model round trips ===")
    for name, arm_idx in (("pipeline", 1), ("loop", 2)):
        steps = [pr[arm_idx]["steps"] for pr in pairs if pr[arm_idx]["steps"]]
        tcs = [pr[arm_idx]["tool_calls"] for pr in pairs if pr[arm_idx]["tool_calls"] is not None]
        print(f"  {name:8} steps median {fmt(med(steps))} max {max(steps) if steps else 0}   "
              f"tool_calls total {sum(tcs)} max {max(tcs) if tcs else 0}")

    # ---- grounding -------------------------------------------------------
    print("\n=== grounding (quality guard — speed is worthless if this drops) ===")
    for name, i in (("pipeline", 1), ("loop", 2)):
        src = [pr[i]["sources"] for pr in pairs]
        cited = [pr[i]["citations"] for pr in pairs]
        withsrc = sum(1 for s in src if s > 0)
        print(f"  {name:8} sources median {fmt(med(src))}  turns with sources {withsrc}/{len(src)}  "
              f"citations median {fmt(med(cited))}")

    # ---- failures --------------------------------------------------------
    print("\n=== failures ===")
    for name, i in (("pipeline", 1), ("loop", 2)):
        empt = [pr[i] for pr in pairs if pr[i]["empty"]]
        bad = [pr[i] for pr in pairs if pr[i]["http"] != 200]
        print(f"  {name:8} empty answers {len(empt)}  non-200 {len(bad)}")
        for e in empt:
            print(f"             empty: {e['probe']} r{e['round']}")

    # ---- retrieval decision ---------------------------------------------
    #
    # READ THIS BEFORE READING THE NUMBER. `expectSearch` in flow-probes.json
    # asks "should this turn fire a NEW web search", which was the right
    # question for the agentic loop, where searching costs a model round trip.
    # Under the pipeline it is the wrong question: retrieval fires
    # speculatively on every turn regardless, and the decision is whether the
    # already-paid-for sources are KEPT. Keeping them costs prompt tokens and
    # no round trip.
    #
    # So the pipeline deliberately diverges on the settled-knowledge probes —
    # "what is TCP" is expectSearch=False yet is answered better with sources
    # and no slower. That divergence is the design, not a miss. It is reported
    # split out so it cannot be read as an error rate.
    print("\n=== retrieval decision ===")
    print("  (expectSearch was written for the loop — see the note in this script;")
    print("   'extra' means sources kept on a probe the loop would not have searched)")
    for name, i in (("pipeline", 1), ("loop", 2)):
        agree = sum(1 for pr in pairs if (pr[i]["sources"] > 0) == pr[i]["expectSearch"])
        extra = sum(1 for pr in pairs if pr[i]["sources"] > 0 and not pr[i]["expectSearch"])
        missing = sum(1 for pr in pairs if pr[i]["sources"] == 0 and pr[i]["expectSearch"])
        print(f"  {name:8} agrees {agree}/{len(pairs)}   extra-sourced {extra}   "
              f"UNSOURCED-but-expected {missing}")
    print("  'UNSOURCED-but-expected' is the one that is unambiguously bad:")
    print("  a question needing current facts that got none.")

    # ---- per-probe table -------------------------------------------------
    print("\n=== per pair ===")
    print(f"  {'probe':6} {'rnd':3} {'pipe_s':>7} {'loop_s':>7} {'delta':>7} "
          f"{'p_st':>4} {'l_st':>4} {'p_src':>5} {'l_src':>5} {'p_cit':>5} {'l_cit':>5}")
    for (probe, rnd), p, l in pairs:
        print(f"  {probe:6} {rnd:3} {p['total_s']:7.1f} {l['total_s']:7.1f} "
              f"{p['total_s'] - l['total_s']:7.1f} {str(p['steps']):>4} {str(l['steps']):>4} "
              f"{p['sources']:5} {l['sources']:5} {p['citations']:5} {l['citations']:5}")


if __name__ == "__main__":
    main()
