#!/usr/bin/env python3
"""Multi-turn conversation runner for flow arms.

WHY THIS EXISTS, given run-flow-arms.py already exists: that runner sends every
probe as a NEW chat. All 96 turns of the first experiment were cold starts,
which misses precisely the cases the arms should differ on most —

  * the mandatory-search rule's ONLY exception is a follow-up that clarifies
    something the assistant already said, so it is never exercised cold;
  * skipSearch fires mostly on follow-ups (6 of 7 zero-tool prod turns were
    "summarise what we said" style);
  * context accumulation, which dominated the latency tail on prod, only
    exists from turn 2 onward;
  * whether a grounding contract still holds when the model can lean on
    conversation history rather than its own knowledge.

Each conversation keeps ONE chatId across all turns, with isNewChat only on the
first — the server loads history from Postgres, so a follow-up is just the same
chatId again.

Usage:
  run-flow-conversations.py --arms baseline,adaptive --out results/convo.jsonl
"""
import argparse, json, os, subprocess, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path("/home/nightfury/selfhosted/ask")
LAB = "http://192.168.50.231:3742"
# The VPN overlay MUST be included in every compose invocation that recreates a
# service. Omit it and compose happily rebuilds `ask` from the overlay-less
# config, which points SEARXNG_API_URL back at a `searxng` hostname that no
# longer resolves (searxng lives in gluetun's namespace now). Observed failure:
# the arm switch left ask stuck in `created` and the run aborted on turn 1.
COMPOSE = ["-f", "docker-compose.yaml", "-f", "docker-compose.lab.yaml",
           "-f", "docker-compose.vpn.lab.yaml"]
PROJ = "ask-stack-lab"
# Was 290. A turn that overruns the client timeout is not merely recorded as
# slow — urllib disconnects, the server's stream aborts before it persists, and
# the turn leaves NO assistant message and NO usage in telemetry. The harness
# then reads the previous turn's text and silently reports it as this turn's
# answer. That cost a whole run: adaptive's c4-current turns showed 420s/374s
# with prompt_tokens=None and an answer_chars frozen at turn 1's value.
# Set well above any plausible turn so slow turns are measured, not vanished.
TURN_TIMEOUT = 900

# Each conversation deliberately mixes turn KINDS, because that is what a real
# thread does and what the arms must handle without a mode switch:
#   fresh   - a new question needing retrieval
#   followup- builds on the previous answer, still needs new facts
#   context - answerable purely from what was already said; the case where a
#             flow SHOULD stop searching, and where baseline's one exception
#             lives
CONVERSATIONS = [
    {
        "id": "c1-postgres",
        "turns": [
            ("fresh", "What is logical replication in Postgres?"),
            ("followup", "What are its main limitations?"),
            ("context", "Summarise those limitations as a short list."),
            ("followup", "Which of them would bite a 2TB database hardest?"),
            ("context", "Give me your recommendation in two sentences."),
        ],
    },
    {
        "id": "c2-espresso",
        "turns": [
            ("fresh", "Why does espresso taste sour?"),
            ("followup", "I already grind finer and it is still sour, what now?"),
            ("context", "Of the fixes you listed, which is cheapest to try?"),
            ("followup", "Does water temperature matter more than grind size?"),
            ("context", "Put the whole thing into an ordered checklist."),
        ],
    },
    {
        "id": "c3-typescript",
        "turns": [
            ("fresh", "What does the satisfies operator do in TypeScript?"),
            ("context", "How is that different from a plain type annotation?"),
            ("followup", "Show a case where it prevents a real bug."),
            ("context", "So when should I reach for it?"),
            ("followup", "Are there cases where it makes things worse?"),
        ],
    },
    {
        # DISCRIMINATING SET. The three conversations above are all stable
        # knowledge, so an arm that never searches scores well on them and an
        # arm that always searches looks wasteful — neither result separates
        # "correctly declining" from indiscriminate suppression, which is the
        # documented failure mode of prompt-based search reduction.
        #
        # Every turn here needs CURRENT fact. A flow that answers these from
        # training data is not being efficient, it is being wrong, and the user
        # cannot tell.
        "id": "c4-current",
        "turns": [
            ("fresh", "What is the newest stable Linux kernel release right now?"),
            ("followup", "What notable changes landed in it?"),
            ("followup", "How much does a Raspberry Pi 5 16GB cost today?"),
            ("followup", "What is the current release version of Node.js LTS?"),
            ("context", "List the version numbers you gave me in this conversation."),
        ],
    },
]


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def set_arm(arm: str) -> None:
    env = {**os.environ, "FLOW_VARIANT": arm}
    sh(["docker", "compose", *COMPOSE, "-p", PROJ, "up", "-d", "ask"], cwd=ROOT, env=env)
    for _ in range(60):
        try:
            with urllib.request.urlopen(LAB + "/", timeout=5) as r:
                if r.status == 200:
                    break
        except Exception:
            pass
        time.sleep(2)
    got = sh(["docker", "exec", "ask-lab", "printenv", "FLOW_VARIANT"]).stdout.strip()
    if got != arm:
        raise SystemExit(f"arm mismatch: asked {arm}, got {got!r}")
    sh(["docker", "exec", "ask-redis-lab", "redis-cli", "del", "latency:log"])


def post_turn(chat_id: str, text: str, first: bool) -> int:
    body = json.dumps({
        "chatId": chat_id,
        "trigger": "submit-message",
        "isNewChat": first,
        "message": {"id": f"m_{chat_id}_{int(time.time()*1000)}", "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(LAB + "/api/chat", data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Connection": "close",
        "Cookie": "selectedModel=ollama:kimi-k2.6%3Acloud; searchMode=balanced",
    })
    try:
        with urllib.request.urlopen(req, timeout=TURN_TIMEOUT) as r:
            r.read()
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def turn_telemetry(chat_id: str, seen: set) -> dict:
    """Newest [latency] line for this chat that we have not already recorded.
    Lines are newest-first, and a conversation produces one per turn."""
    out = sh(["docker", "exec", "ask-redis-lab", "redis-cli",
              "lrange", "latency:log", "0", "-1"]).stdout
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("[latency] "):
            continue
        try:
            t = json.loads(line.split(" ", 1)[1])
        except Exception:
            continue
        if t.get("chatId") != chat_id:
            continue
        key = (t.get("total_ms"), t.get("steps"), t.get("tool_calls"))
        if key in seen:
            continue
        seen.add(key)
        return t
    return {}


def tools_and_answer(chat_id: str) -> tuple:
    tsql = ("SELECT p.type, count(*) FROM parts p JOIN messages m ON m.id=p.message_id "
            f"WHERE m.chat_id='{chat_id}' AND p.type LIKE 'tool-%' GROUP BY 1;")
    tr = sh(["docker", "exec", "ask-postgres-lab", "psql", "-U", "morphic", "-d",
             "morphic", "-tAF,", "-c", tsql]).stdout
    asql = ("SELECT COALESCE(p.text_text,'') FROM parts p JOIN messages m ON m.id=p.message_id "
            f"WHERE m.chat_id='{chat_id}' AND m.role='assistant' AND p.type='text' "
            'AND p.text_text IS NOT NULL ORDER BY m.created_at DESC, p."order" DESC LIMIT 1;')
    ar = sh(["docker", "exec", "ask-postgres-lab", "psql", "-U", "morphic", "-d",
             "morphic", "-tAc", asql]).stdout
    return tr.strip(), (ar or "").strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="baseline,adaptive")
    ap.add_argument("--out", default="scripts/eval/results/flow-conversations.jsonl")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    arms = [x.strip() for x in a.arms.split(",") if x.strip()]
    convos = ([c for c in CONVERSATIONS if c["id"] == a.only] if a.only else CONVERSATIONS)

    out_path = ROOT / a.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fh = out_path.open("w")
    n_turns = sum(len(c["turns"]) for c in convos)
    print(f"arms={arms}  {len(convos)} conversations x turns = {n_turns} per arm\n", flush=True)

    for arm in arms:
        print(f"=== {arm} ===", flush=True)
        set_arm(arm)
        for convo in convos:
            chat_id = f"cv_{arm.replace('-','_')}_{convo['id'].replace('-','_')}_{int(time.time())}"
            seen, prev_tools, prev_answer = set(), "", None
            print(f"  {convo['id']}", flush=True)
            for i, (kind, text) in enumerate(convo["turns"]):
                code = post_turn(chat_id, text, first=(i == 0))
                time.sleep(2)
                t = turn_telemetry(chat_id, seen)
                tools_csv, answer = tools_and_answer(chat_id)
                # Tool counts are cumulative per chat, so the delta is this
                # turn's contribution.
                delta = len(tools_csv) - len(prev_tools)
                prev_tools = tools_csv
                # The answer query returns the newest assistant text in the
                # chat, which is the PREVIOUS turn's text when this turn
                # persisted nothing. Without this flag a dead turn is
                # indistinguishable from a good one in the results file.
                answered = prev_answer is None or answer != prev_answer
                prev_answer = answer
                rec = {
                    "arm": arm, "convo": convo["id"], "turn": i + 1, "kind": kind,
                    "question": text, "http": code,
                    "total_s": round((t.get("total_ms") or 0) / 1000, 1),
                    "steps": t.get("steps"), "tool_calls": t.get("tool_calls"),
                    "prompt_tokens": t.get("prompt_tokens"),
                    "ingest_ms": t.get("ingest_ms"),
                    "skipSearch": t.get("skipSearch"),
                    "answer_chars": len(answer),
                    "answered": answered,
                    "answer": answer[:4000],
                }
                fh.write(json.dumps(rec) + "\n"); fh.flush()
                print("    t%d %-8s %6.1fs steps=%-3s tools=%-3s ptok=%-7s %s" % (
                    i + 1, kind, rec["total_s"], rec["steps"], rec["tool_calls"],
                    rec["prompt_tokens"],
                    "" if answered and rec["answer_chars"] else "(NO ANSWER)"),
                    flush=True)
    fh.close()
    print(f"\nwrote {out_path}", flush=True)


if __name__ == "__main__":
    main()
