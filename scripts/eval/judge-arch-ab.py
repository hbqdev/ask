#!/usr/bin/env python3
"""Blind pairwise quality judging for the architecture A/B.

Speed without a quality check is not a result — an architecture that answers
faster because it answers worse would win every latency table here. This reuses
judge-flow-arms.py's controls rather than reimplementing them:

  * PAIRWISE forced choice, not absolute scores (absolute LLM ratings cluster
    at 4 and barely separate systems).
  * POSITION BIAS CONTROLLED — each pair judged twice with sides swapped, and
    a win only counts when the same answer wins both orderings. Disagreement
    is recorded as a TIE, never silently resolved.
  * JUDGED BY A DIFFERENT MODEL than the one under test, since models prefer
    their own output.
  * The judge sees no arm label and no latency.

This adapter exists only because the A/B file has TWO rows per (arm, probe) —
one per round — and judge-flow-arms.py keys on probe alone, so it would
silently judge whichever round happened to be written last and discard half the
evidence. Rounds are folded into the probe key so every round is judged.

Usage:
  judge-arch-ab.py scripts/eval/results/arch-ab.jsonl
"""
import argparse, json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--out", default="scripts/eval/results/arch-ab-judge.jsonl")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.path).read_text().splitlines() if l.strip()]

    # Only judge pairs where BOTH arms produced an answer. An empty answer is a
    # failure already counted by the analyzer; feeding it to the judge would
    # score the same defect twice, once as a crash and once as a quality loss.
    have = {}
    for r in rows:
        have.setdefault((r["probe"], r["round"]), {})[r["arm"]] = r
    complete = {k: v for k, v in have.items()
                if {"pipeline", "loop"} <= v.keys()
                and v["pipeline"]["answer"].strip() and v["loop"]["answer"].strip()}
    dropped = len(have) - len(complete)

    adapted = HERE / "results" / "arch-ab-judgeinput.jsonl"
    adapted.parent.mkdir(parents=True, exist_ok=True)
    with adapted.open("w") as fh:
        for (probe, rnd), v in sorted(complete.items()):
            for arm in ("loop", "pipeline"):
                r = dict(v[arm])
                r["probe"] = f"{probe}_r{rnd}"
                fh.write(json.dumps(r) + "\n")

    # Not silent: a dropped pair is coverage this run does not have, and the
    # summary must not read as though it judged everything.
    print(f"judging {len(complete)} pairs; dropped {dropped} incomplete/empty\n", flush=True)

    # `loop` is the baseline — it is the architecture being replaced, so the
    # question is whether the pipeline is worse than what already ships.
    sys.exit(subprocess.call(
        [sys.executable, str(HERE / "judge-flow-arms.py"), str(adapted),
         "--baseline", "loop", "--out", a.out]
    ))


if __name__ == "__main__":
    main()
