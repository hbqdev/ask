#!/usr/bin/env python3
"""Does the flow's SHAPE depend on which model is selected?

THE CLAIM UNDER TEST. The pipeline's headline property is that step count is
fixed by code, so swapping the model in the UI changes prose quality and speed
but never the control flow. The loop's shape, by contrast, is a property of the
model: on an identical probe set kimi-k2.6 answered "do I have enough or should
I search again?" 19 times and minimax-m3 answered it 3 times. An architecture
whose shape depends on which model is selected is not an architecture.

That claim is about VARIANCE ACROSS MODELS WITHIN AN ARM, which no single-model
run can show. This script takes two A/B files produced with different
EVAL_MODEL values and reports, per arm, how far the step and tool-call profile
moves when only the model changes.

The unit is the per-probe difference between models, not each model's mean:
probes differ enormously in how much work they invite, so a pooled mean would
mostly measure which probes were in the set.

Usage:
  compare-models.py --a results/arch-ab.jsonl --a-name kimi-k2.6 \
                    --b results/arch-ab-minimax.jsonl --b-name minimax-m3
"""
import argparse, json, statistics as st
from collections import defaultdict
from pathlib import Path


def load(path):
    rows = [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
    # Collapse rounds: keep the MEDIAN steps per (arm, probe) so one unlucky
    # turn cannot stand in for a model's behaviour.
    grouped = defaultdict(list)
    for r in rows:
        grouped[(r["arm"], r["probe"])].append(r)
    out = {}
    for k, rs in grouped.items():
        steps = [x["steps"] for x in rs if x["steps"]]
        tcs = [x["tool_calls"] for x in rs if x["tool_calls"] is not None]
        out[k] = {
            "steps": st.median(steps) if steps else None,
            "tool_calls": st.median(tcs) if tcs else None,
            "total_s": st.median([x["total_s"] for x in rs]),
            "empty": any(x["empty"] for x in rs),
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True)
    ap.add_argument("--a-name", default="model-A")
    ap.add_argument("--b", required=True)
    ap.add_argument("--b-name", default="model-B")
    args = ap.parse_args()

    A, B = load(args.a), load(args.b)
    arms = sorted({k[0] for k in A} & {k[0] for k in B})

    print(f"{args.a_name}  vs  {args.b_name}\n")
    for arm in arms:
        probes = sorted({k[1] for k in A if k[0] == arm} & {k[1] for k in B if k[0] == arm})
        if not probes:
            continue
        d_steps, d_tc = [], []
        print(f"=== arm: {arm} ===")
        print(f"  {'probe':6} {'A_st':>5} {'B_st':>5} {'A_tc':>5} {'B_tc':>5}")
        for p in probes:
            a, b = A[(arm, p)], B[(arm, p)]
            if a["steps"] is not None and b["steps"] is not None:
                d_steps.append(abs(a["steps"] - b["steps"]))
            if a["tool_calls"] is not None and b["tool_calls"] is not None:
                d_tc.append(abs(a["tool_calls"] - b["tool_calls"]))
            print(f"  {p:6} {str(a['steps']):>5} {str(b['steps']):>5} "
                  f"{str(a['tool_calls']):>5} {str(b['tool_calls']):>5}")
        # The headline number: how much the flow MOVES when only the model
        # changes. Zero means the architecture, not the model, decides.
        print(f"  -> median |step delta| between models: "
              f"{st.median(d_steps) if d_steps else float('nan'):.1f}"
              f"   max {max(d_steps) if d_steps else 0}")
        print(f"  -> median |tool-call delta| between models: "
              f"{st.median(d_tc) if d_tc else float('nan'):.1f}"
              f"   max {max(d_tc) if d_tc else 0}")
        print(f"  -> total tool calls: {args.a_name}="
              f"{sum(A[(arm, p)]['tool_calls'] or 0 for p in probes):.0f}"
              f"  {args.b_name}="
              f"{sum(B[(arm, p)]['tool_calls'] or 0 for p in probes):.0f}\n")


if __name__ == "__main__":
    main()
