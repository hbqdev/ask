#!/usr/bin/env python3
"""Run the SAME multi-turn conversations against staging and lab, side by side.

WHAT THIS ANSWERS THAT THE A/B DOES NOT. run-arch-ab.py compares two arms on
ONE instance with single-turn probes. That isolates flow, but it cannot see the
things that only exist across turns — referential follow-ups, skipSearch on a
"summarise that" turn, whether context survives — and it says nothing about how
the pipeline compares to what staging actually serves today.

THE CONFOUND THIS RUN HAD TO KILL FIRST. Staging merges five sources (searxng,
degoog, tavily, brave, langsearch); the lab was deliberately SearXNG-only so
that flow was the only moving part. Comparing them in that state would have
measured retrieval breadth at least as much as architecture — the same class of
mistake that produced two wrong conclusions earlier in this work. The lab's
source stack is now matched to staging (docker-compose.lab.yaml), so FLOW_ARCH
is the only remaining difference.

WHAT IS STILL NOT CONTROLLED, and must be read alongside any result:
  * Separate Postgres, separate SearXNG index, separate degoog exit. Same
    software and settings, different instances.
  * Staging serves real traffic; the lab does not. Cache state differs.
  * One model (kimi-k2.6), one question set, one run.

Turns within a chat are STRICTLY SEQUENTIAL and the same on both sides, because
a follow-up only means anything against the answer that preceded it.

Usage:
  compare-instances.py --out scripts/eval/results/instances.jsonl
"""
import argparse, json, os, subprocess, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODEL = os.environ.get("EVAL_MODEL", "kimi-k2.6:cloud")
TURN_TIMEOUT = 290

INSTANCES = {
    "staging": {"url": "http://192.168.50.231:3739", "container": "ask-admin-feature",
                "pg": "ask-postgres-admin-feature", "redis": "ask-redis-admin-feature"},
    "lab": {"url": "http://192.168.50.231:3742", "container": "ask-lab",
            "pg": "ask-postgres-lab", "redis": "ask-redis-lab"},
}

# Follow-ups are deliberately REFERENTIAL ("that", "them", "it") — they are the
# whole point of a multi-turn run and the thing single-turn probes cannot test.
CONVERSATIONS = [
    ["What is the current stable version of PostgreSQL?",
     "What were the headline changes in that major version?",
     "Summarise that in three bullets, no more."],
    ["Compare Caddy, Traefik and nginx as reverse proxies.",
     "Which of them is easiest to set up for automatic HTTPS?",
     "Remember that I run Caddy in production on Debian."],
    ["What is the difference between TCP and UDP?",
     "Which one does HTTP/3 use, and why did they switch?",
     "So for a video call I'd want the second one, right?"],
    ["What are the latest reported figures for global EV sales?",
     "How does China compare with Europe there?",
     "What is driving the gap between them?"],
    ["Is SQLite a reasonable choice for a web app with about 200 concurrent users?",
     "What breaks first as that grows?",
     "What would you switch to, and why?"],
]


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def post_turn(url: str, chat_id: str, text: str, first: bool):
    body = json.dumps({
        "chatId": chat_id, "trigger": "submit-message", "isNewChat": first,
        "message": {"id": f"m_{chat_id}_{int(time.time()*1000)}", "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(url + "/api/chat", data=body, method="POST", headers={
        "Content-Type": "application/json", "Connection": "close",
        "Cookie": f"selectedModel=ollama:{MODEL.replace(':', '%3A')}; searchMode=balanced",
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TURN_TIMEOUT) as r:
            r.read()
            return r.status, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, time.time() - t0
    except Exception:
        return 0, time.time() - t0


def telemetry(inst, chat_id, seen):
    """The LAST unseen [latency] line for this chat — one per turn, and a chat
    accumulates them, so taking the first would report turn 1 forever."""
    out = sh(["docker", "exec", inst["redis"], "redis-cli",
              "lrange", "latency:log", "0", "-1"]).stdout
    best = None
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("[latency] "):
            continue
        try:
            t = json.loads(line.split(" ", 1)[1])
        except Exception:
            continue
        if t.get("chatId") == chat_id and id(line) not in seen and line not in seen:
            best = (line, t)
    if best:
        seen.add(best[0])
        return best[1]
    return {}


def psql(inst, sql):
    return (sh(["docker", "exec", inst["pg"], "psql", "-U", "morphic", "-d",
                "morphic", "-tAc", sql]).stdout or "").strip()


def last_answer(inst, chat_id):
    return psql(inst,
        "SELECT COALESCE(p.text_text,'') FROM parts p JOIN messages m ON m.id=p.message_id "
        f"WHERE m.chat_id='{chat_id}' AND m.role='assistant' AND p.type='text' "
        "AND p.text_text IS NOT NULL ORDER BY m.created_at DESC, p.\"order\" DESC LIMIT 1;")


def turn_sources(inst, chat_id, prior):
    """Sources on the LATEST assistant message only — a chat accumulates
    tool-search parts, so a chat-wide sum would grow every turn regardless."""
    n = psql(inst,
        "SELECT COALESCE(SUM(json_array_length(p.tool_search_output->'results')),0) "
        "FROM parts p JOIN messages m ON m.id=p.message_id "
        f"WHERE m.chat_id='{chat_id}' AND p.type='tool-search' "
        "AND json_typeof(p.tool_search_output->'results')='array';")
    total = int(n) if n.lstrip("-").isdigit() else 0
    return total - prior, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="scripts/eval/results/instances.jsonl")
    a = ap.parse_args()

    out_path = ROOT / a.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fh = out_path.open("w")

    for name, inst in INSTANCES.items():
        sh(["docker", "exec", inst["redis"], "redis-cli", "del", "latency:log"])
        print(f"\n########## {name} ##########", flush=True)
        for ci, convo in enumerate(CONVERSATIONS, 1):
            chat_id = f"cmp_{name}_c{ci}_{int(time.time())}"
            seen, prior = set(), 0
            for ti, question in enumerate(convo, 1):
                code, wall = post_turn(inst["url"], chat_id, question, first=(ti == 1))
                time.sleep(3)  # let async persistence land
                t = telemetry(inst, chat_id, seen)
                ans = last_answer(inst, chat_id)
                delta, prior = turn_sources(inst, chat_id, prior)
                s = t.get("stream", {}) or {}
                rec = {
                    "instance": name, "chat": ci, "turn": ti, "question": question,
                    "http": code, "wall_s": round(wall, 1),
                    "total_s": round((t.get("total_ms") or 0) / 1000, 1),
                    "steps": t.get("steps"), "tool_calls": t.get("tool_calls"),
                    "sources": delta, "answer_chars": len(ans),
                    "empty": len(ans.strip()) == 0,
                    "citations": ans.count("](#"),
                    "skipSearch": t.get("skipSearch"),
                    "last_prompt_tokens": t.get("last_prompt_tokens"),
                    "wrote_prose": "text-start" in s,
                    "answer": ans,
                }
                fh.write(json.dumps(rec) + "\n"); fh.flush()
                print(f"  c{ci}t{ti} {rec['total_s']:6.1f}s steps={rec['steps']} "
                      f"tc={rec['tool_calls']} src={rec['sources']:3} "
                      f"chars={rec['answer_chars']:5} cite={rec['citations']:3} "
                      f"skip={rec['skipSearch']}", flush=True)
    fh.close()
    print(f"\ndone -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
