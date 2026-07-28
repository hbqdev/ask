#!/usr/bin/env python3
"""Run the flow-probe set through every control-flow arm on the lab instance.

WHY A SEPARATE RUNNER from scripts/eval/run-eval.ts: that harness compares
(model, searchMode) pairs and judges answer QUALITY pairwise, which is exactly
right for "is arm X's answer better than arm Y's". It has no notion of whether
a turn made the correct RETRIEVAL DECISION, which is the primary thing these
arms differ on. This runner measures the decision and the mechanics; the
existing harness is then pointed at the survivors to judge quality.

Arms are switched by restarting the lab container with a different
FLOW_VARIANT, so runs are strictly sequential — which also keeps latency
figures honest, since concurrent turns would contend for the same SearXNG and
crawler.

Usage:
  run-flow-arms.py --arms baseline,adaptive --out results/flows-<ts>.jsonl
  run-flow-arms.py --arms all --limit 4
"""
import argparse, json, os, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

ROOT = Path("/home/nightfury/selfhosted/ask")
LAB = "http://192.168.50.231:3742"
# Must include the VPN overlay — see the note in run-flow-conversations.py.
COMPOSE = ["-f", "docker-compose.yaml", "-f", "docker-compose.lab.yaml",
           "-f", "docker-compose.vpn.lab.yaml"]
PROJ = "ask-stack-lab"
ALL_ARMS = ["baseline", "adaptive", "router", "react-gap", "plan-execute", "wide-once"]
# The route's own ceiling is 300s; stay under it so a timeout is attributable
# to the turn rather than to the client giving up first.
TURN_TIMEOUT = 290


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
    # Confirm the container really came up on the requested arm rather than
    # trusting the compose call — a silent fallback would mislabel a whole arm.
    got = sh(["docker", "exec", "ask-lab", "printenv", "FLOW_VARIANT"]).stdout.strip()
    if got != arm:
        raise SystemExit(f"arm mismatch: asked for {arm}, container reports {got!r}")
    sh(["docker", "exec", "ask-redis-lab", "redis-cli", "del", "latency:log"])


def post_turn(chat_id: str, text: str) -> tuple[int, float]:
    body = json.dumps({
        "chatId": chat_id,
        "trigger": "submit-message",
        "isNewChat": True,
        "message": {"id": "m_" + chat_id, "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(LAB + "/api/chat", data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Connection": "close",
        "Cookie": "selectedModel=ollama:kimi-k2.6%3Acloud; searchMode=balanced",
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


def telemetry(chat_id: str) -> dict:
    out = sh(["docker", "exec", "ask-redis-lab", "redis-cli", "lrange", "latency:log", "0", "-1"]).stdout
    turn, searches = None, []
    for line in out.splitlines():
        line = line.strip()
        try:
            if line.startswith("[latency] "):
                t = json.loads(line.split(" ", 1)[1])
                if t.get("chatId") == chat_id and turn is None:
                    turn = t
            elif line.startswith("[latency:search] "):
                s = json.loads(line.split(" ", 1)[1])
                if s.get("chatId") == chat_id:
                    searches.append(s)
        except Exception:
            continue
    return {"turn": turn, "searches": searches}


def tool_types(chat_id: str) -> list:
    """Which tools actually ran, from persisted parts — the only reliable
    source. The [latency] line counts tool calls but does not name them."""
    sql = (
        "SELECT p.type, count(*) FROM parts p JOIN messages m ON m.id = p.message_id "
        f"WHERE m.chat_id = '{chat_id}' AND p.type LIKE 'tool-%' GROUP BY 1;"
    )
    r = sh(["docker", "exec", "ask-postgres-lab", "psql", "-U", "morphic", "-d", "morphic", "-tAF,", "-c", sql])
    out = []
    for line in (r.stdout or "").strip().splitlines():
        if "," in line:
            t, n = line.rsplit(",", 1)
            out.extend([t.strip()] * int(n))
    return out


def answer_text(chat_id: str) -> str:
    # Content lives in the `parts` table, not messages.metadata — that column
    # holds only {modelId, searchMode}. Mirrors run-eval.ts's query.
    sql = (
        "SELECT COALESCE(p.text_text, '') FROM parts p JOIN messages m ON m.id = p.message_id "
        f"WHERE m.chat_id = '{chat_id}' AND m.role = 'assistant' "
        "AND p.type = 'text' AND p.text_text IS NOT NULL "
        'ORDER BY p."order" DESC LIMIT 1;'
    )
    r = sh(["docker", "exec", "ask-postgres-lab", "psql", "-U", "morphic", "-d", "morphic", "-tAc", sql])
    return (r.stdout or "").strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="all")
    ap.add_argument("--probes", default="scripts/eval/flow-probes.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    arms = ALL_ARMS if a.arms == "all" else [x.strip() for x in a.arms.split(",") if x.strip()]
    probes = json.loads((ROOT / a.probes).read_text())["probes"]
    if a.limit:
        probes = probes[: a.limit]

    out_path = ROOT / (a.out or f"scripts/eval/results/flows-{int(time.time())}.jsonl")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fh = out_path.open("w")
    print(f"arms={arms}  probes={len(probes)}  -> {out_path}", flush=True)

    for arm in arms:
        print(f"\n=== {arm} ===", flush=True)
        set_arm(arm)
        for p in probes:
            chat_id = f"flow_{arm.replace('-', '_')}_{p['id']}_{int(time.time())}"
            code, wall = post_turn(chat_id, p["text"])
            time.sleep(2)  # let the async persistence land
            tel = telemetry(chat_id)
            ans = answer_text(chat_id)
            turn = tel["turn"] or {}
            tools_used = tool_types(chat_id)
            searched = any(t.startswith("tool-search") for t in tools_used)
            rec = {
                "arm": arm, "probe": p["id"], "question": p["text"],
                "expectSearch": p["expectSearch"], "http": code,
                "wall_s": round(wall, 1),
                "total_s": round((turn.get("total_ms") or 0) / 1000, 1),
                "steps": turn.get("steps"), "tool_calls": turn.get("tool_calls"),
                "searched": searched, "n_search_lines": len(tel["searches"]),
                "tools_used": tools_used,
                "decision_correct": searched == p["expectSearch"],
                "answer_chars": len(ans),
                "has_heading": ans.lstrip().startswith("##"),
                "mustMention_ok": (p["mustMention"].lower() in ans.lower())
                    if p.get("mustMention") else None,
                "answer": ans,
            }
            fh.write(json.dumps(rec) + "\n"); fh.flush()
            print("  %-4s %-5s %6.1fs steps=%-3s tools=%-3s searched=%-5s %s %s" % (
                p["id"], code, rec["total_s"], rec["steps"], rec["tool_calls"],
                searched, "OK " if rec["decision_correct"] else "MISS",
                "" if rec["answer_chars"] else "(EMPTY ANSWER)"), flush=True)
    fh.close()
    print(f"\nwrote {out_path}", flush=True)


if __name__ == "__main__":
    main()
