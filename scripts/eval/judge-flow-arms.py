#!/usr/bin/env python3
"""Blind pairwise quality judging for flow arms.

Latency and decision-correctness cannot tell you whether an arm answers WORSE.
An arm that never searches wins every speed table and would be a disaster to
ship, so quality is judged separately and reported alongside, never merged into
a single score.

Design choices that matter for trusting the output:

* PAIRWISE, not absolute scoring. Absolute 1-5 ratings from an LLM cluster
  around 4 and barely separate systems; forced choice between two concrete
  answers discriminates far better.
* POSITION-BIAS CONTROLLED. Every pair is judged twice with the answers
  swapped. A pair only counts as a win if the SAME answer wins both
  orderings; disagreement is recorded as a tie, not silently resolved. LLM
  judges have a well-documented preference for whichever answer they see
  first, and without this control that bias is indistinguishable from signal.
* JUDGED BY A DIFFERENT MODEL than the one under test (glm-5.2 vs kimi-k2.6),
  because models systematically prefer their own output.
* The judge never sees which arm produced which answer, or any latency.

Usage:
  judge-flow-arms.py results/flow-arms-run1.jsonl --baseline baseline
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request
from collections import defaultdict
from pathlib import Path

OLLAMA = os.environ.get("JUDGE_OLLAMA_URL", "http://192.168.50.231:11434")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "glm-5.2:cloud")

RUBRIC = """You are judging two answers to the same question, produced by two different research systems.

Judge on, in order of importance:
1. CORRECTNESS — is it accurate and free of invented facts?
2. GROUNDING — are claims attributable? An answer that says plainly it is answering from general knowledge is HONEST and acceptable. An answer with fabricated or broken citations is much worse than one with none.
3. COMPLETENESS — does it actually answer what was asked, including every part of a multi-part question?
4. USEFULNESS — would this help the person who asked? Concrete beats vague. Excess length is not quality.

Ignore formatting differences, tone, and length unless they affect the above.

Reply with EXACTLY one line:
WINNER: A
or
WINNER: B
or
WINNER: TIE"""


def ask_judge(question: str, a: str, b: str) -> str:
    prompt = (f"{RUBRIC}\n\nQUESTION:\n{question}\n\n"
              f"--- ANSWER A ---\n{a[:6000]}\n\n--- ANSWER B ---\n{b[:6000]}\n")
    body = json.dumps({
        "model": JUDGE_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/chat", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                txt = json.loads(r.read())["message"]["content"]
            m = re.search(r"WINNER:\s*(A|B|TIE)", txt, re.I)
            return m.group(1).upper() if m else "TIE"
        except Exception:
            time.sleep(3 * (attempt + 1))
    return "TIE"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--baseline", default="baseline")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    rows = [json.loads(l) for l in Path(a.results).read_text().splitlines() if l.strip()]
    by = defaultdict(dict)
    for r in rows:
        by[r["arm"]][r["probe"]] = r
    arms = [x for x in by if x != a.baseline]
    if a.baseline not in by:
        raise SystemExit(f"baseline arm {a.baseline!r} not in results")

    print(f"judge={JUDGE_MODEL}  baseline={a.baseline}  challengers={arms}\n")
    out = []
    for arm in arms:
        wins = losses = ties = skipped = 0
        for probe, base in by[a.baseline].items():
            cand = by[arm].get(probe)
            # An empty answer is a failure, not a judgeable answer — count it
            # rather than letting the judge compare against nothing.
            if not cand or not cand["answer"].strip() or not base["answer"].strip():
                skipped += 1
                continue
            q = base["question"]
            # Both orderings; only an answer that wins BOTH counts as a win.
            r1 = ask_judge(q, base["answer"], cand["answer"])   # A=baseline
            r2 = ask_judge(q, cand["answer"], base["answer"])   # A=candidate
            if r1 == "B" and r2 == "A":
                wins += 1; verdict = "win"
            elif r1 == "A" and r2 == "B":
                losses += 1; verdict = "loss"
            else:
                ties += 1; verdict = "tie"
            out.append({"arm": arm, "probe": probe, "verdict": verdict,
                        "order1": r1, "order2": r2})
            print(f"  {arm:<13} {probe}  {verdict:<5} ({r1}/{r2})", flush=True)
        n = wins + losses + ties
        print(f"  -> {arm}: {wins}W {losses}L {ties}T  (skipped {skipped})"
              f"   net {wins - losses:+d} of {n}\n", flush=True)

    print("SUMMARY vs", a.baseline)
    print("  %-13s %4s %4s %4s %8s" % ("arm", "W", "L", "T", "net"))
    for arm in arms:
        rs = [o for o in out if o["arm"] == arm]
        w = sum(1 for o in rs if o["verdict"] == "win")
        l = sum(1 for o in rs if o["verdict"] == "loss")
        t = sum(1 for o in rs if o["verdict"] == "tie")
        print("  %-13s %4d %4d %4d %+8d" % (arm, w, l, t, w - l))

    if a.out:
        Path(a.out).write_text("\n".join(json.dumps(o) for o in out))
        print(f"\nwrote {a.out}")


if __name__ == "__main__":
    main()
