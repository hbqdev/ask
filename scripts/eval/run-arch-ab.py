#!/usr/bin/env python3
"""A/B the pipeline ARCHITECTURE against the agentic loop it replaces.

WHY A THIRD RUNNER. run-flow-arms.py switches FLOW_VARIANT — knobs *inside*
the loop — and run-flow-conversations.py drives multi-turn threads. Neither
varies FLOW_ARCH, which is the thing actually under test: `pipeline` removes
the loop, so the two arms differ in control structure, not in tuning.

THE CONFOUND THIS RUNNER EXISTS TO KILL. Measured on this stack, a single
retrieval has ranged from 0.3s to 141s depending on how saturated the shared
crawl4ai container is, and turn latency is dominated by retrieval. Two blocks
run back to back therefore measure crawler weather at least as much as they
measure architecture. Three defences:

  * ARM ORDER ALTERNATES EVERY ROUND (pipeline-first, then loop-first, ...),
    so any monotonic drift in crawler health is split evenly between arms
    instead of being paid entirely by whichever ran second.
  * THE SEARCH CACHE IS FLUSHED BEFORE EVERY ARM RUN. Without it the second
    arm of a round answers from the first arm's cached pages and looks
    artificially fast. Both arms always pay full retrieval price.
  * CRAWLER MEMORY IS RECORDED PER TURN. crawl4ai's own memory guard cannot
    fire under mem_limit (psutil reports the host's 31 GiB, not the 8 GiB
    cgroup cap), so saturation is silent from inside the app. If one arm's
    turns cluster at high crawler memory, the comparison is void and the
    numbers say so rather than hiding it.

Comparison is PAIRED: every probe is answered by both arms in every round, so
the per-probe difference is the unit, not the per-arm mean. A mean over probes
of wildly different retrieval cost is dominated by whichever probes happened to
be slow.

Usage:
  run-arch-ab.py --rounds 2 --out scripts/eval/results/arch-ab.jsonl
"""
import argparse, json, os, subprocess, time, urllib.error, urllib.request
from pathlib import Path

# Derived from THIS file, never hardcoded — a hardcoded prod path once made a
# run labelled `pipeline` rebuild the lab from production's checkout and
# silently measure the agentic loop instead.
ROOT = Path(__file__).resolve().parents[2]
LAB = "http://192.168.50.231:3742"
COMPOSE = ["-f", "docker-compose.yaml", "-f", "docker-compose.lab.yaml",
           "-f", "docker-compose.vpn.lab.yaml"]
PROJ = "ask-stack-lab"
MODEL = os.environ.get("EVAL_MODEL", "kimi-k2.6:cloud")
TURN_TIMEOUT = 290

# arm name -> value of FLOW_ARCH. "" is the inherited morphic loop.
ARCHES = {"pipeline": "pipeline", "loop": ""}


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def set_arch(arm: str) -> None:
    """Restart the lab on this architecture, and REFUSE to continue unless the
    container confirms it. A silent fallback mislabels every turn that
    follows, which has happened before and is invisible in the output."""
    arch = ARCHES[arm]
    env = {**os.environ, "FLOW_ARCH": arch, "FLOW_VARIANT": "baseline"}
    # Knobs under test must survive the arm switch. `up -d ask` re-renders the
    # compose environment, so anything set only on the initial deploy silently
    # reverts partway through a run and mislabels every turn after it — which
    # has happened before with FLOW_ARCH.
    for knob in ("PIPELINE_SOURCE_CHARS",):
        if os.environ.get(knob):
            env[knob] = os.environ[knob]
    sh(["docker", "compose", *COMPOSE, "-p", PROJ, "up", "-d", "ask"], cwd=ROOT, env=env)
    for _ in range(90):
        try:
            with urllib.request.urlopen(LAB + "/", timeout=5) as r:
                if r.status == 200:
                    break
        except Exception:
            pass
        time.sleep(2)
    got = sh(["docker", "exec", "ask-lab", "printenv", "FLOW_ARCH"]).stdout.strip()
    if got != arch:
        raise SystemExit(f"arch mismatch: asked {arch!r}, container reports {got!r}")
    var = sh(["docker", "exec", "ask-lab", "printenv", "FLOW_VARIANT"]).stdout.strip()
    if var != "baseline":
        raise SystemExit(f"variant mismatch: expected baseline, got {var!r}")
    sh(["docker", "exec", "ask-redis-lab", "redis-cli", "del", "latency:log"])


def flush_search_cache() -> int:
    """Drop cached search payloads so both arms pay full retrieval.

    Scoped to the `search:*` prefix rather than FLUSHALL: the same redis holds
    this instance's chat state, and wiping it mid-run would change what the
    classifier sees between arms.
    """
    keys = sh(["docker", "exec", "ask-redis-lab", "redis-cli", "--scan",
               "--pattern", "search:*", "--count", "1000"]).stdout.split()
    for k in keys:
        sh(["docker", "exec", "ask-redis-lab", "redis-cli", "del", k])
    return len(keys)


def crawler_mem_pct() -> int:
    """crawl4ai's share of its OWN cgroup limit — the number its internal
    guard cannot see. -1 when unreadable, never a fabricated 0."""
    cur = sh(["docker", "exec", "crawl4ai", "cat", "/sys/fs/cgroup/memory.current"]).stdout.strip()
    mx = sh(["docker", "exec", "crawl4ai", "cat", "/sys/fs/cgroup/memory.max"]).stdout.strip()
    if not cur.isdigit() or not mx.isdigit():
        return -1
    return int(cur) * 100 // int(mx)


def post_turn(chat_id: str, text: str):
    body = json.dumps({
        "chatId": chat_id, "trigger": "submit-message", "isNewChat": True,
        "message": {"id": "m_" + chat_id, "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(LAB + "/api/chat", data=body, method="POST", headers={
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


def telemetry(chat_id: str) -> dict:
    out = sh(["docker", "exec", "ask-redis-lab", "redis-cli",
              "lrange", "latency:log", "0", "-1"]).stdout
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


def psql(sql: str) -> str:
    return (sh(["docker", "exec", "ask-postgres-lab", "psql", "-U", "morphic",
                "-d", "morphic", "-tAc", sql]).stdout or "").strip()


def answer_text(chat_id: str) -> str:
    return psql(
        "SELECT COALESCE(p.text_text, '') FROM parts p JOIN messages m ON m.id = p.message_id "
        f"WHERE m.chat_id = '{chat_id}' AND m.role = 'assistant' "
        "AND p.type = 'text' AND p.text_text IS NOT NULL "
        'ORDER BY p."order" DESC LIMIT 1;'
    )


def source_count(chat_id: str) -> int:
    """How many sources the ANSWER was actually given.

    Counted from the persisted tool-search part, which both arms produce — the
    pipeline synthesizes one precisely so the citation stack keeps working. A
    turn with sources it never cites still had them available, which is the
    thing being compared here; citation discipline is counted separately.
    """
    # The column is `tool_search_output` (per-tool columns, not one generic
    # `tool_output`) and it is `json`, not `jsonb` — json_array_length, and a
    # cast before the type check. Getting either wrong returns 0 for every row
    # and reads as "neither arm retrieved anything", which is how a first pass
    # of this runner reported src=0 across the board.
    n = psql(
        "SELECT COALESCE(SUM(json_array_length(p.tool_search_output->'results')), 0) "
        "FROM parts p JOIN messages m ON m.id = p.message_id "
        f"WHERE m.chat_id = '{chat_id}' AND p.type = 'tool-search' "
        "AND json_typeof(p.tool_search_output->'results') = 'array';"
    )
    return int(n) if n.lstrip("-").isdigit() else 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--probes", default="scripts/eval/flow-probes.json")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="scripts/eval/results/arch-ab.jsonl")
    a = ap.parse_args()

    probes = json.loads((ROOT / a.probes).read_text())["probes"]
    if a.limit:
        probes = probes[: a.limit]

    out_path = ROOT / a.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fh = out_path.open("w")
    print(f"rounds={a.rounds} probes={len(probes)} model={MODEL} -> {out_path}", flush=True)

    for rnd in range(a.rounds):
        # Alternate which arm runs first; see the module docstring.
        order = ["pipeline", "loop"] if rnd % 2 == 0 else ["loop", "pipeline"]
        for arm in order:
            dropped = flush_search_cache()
            set_arch(arm)
            print(f"\n=== round {rnd + 1} arm={arm} (flushed {dropped} cache keys) ===", flush=True)
            for p in probes:
                chat_id = f"ab_{arm}_{p['id']}_r{rnd}_{int(time.time())}"
                mem_before = crawler_mem_pct()
                code, wall = post_turn(chat_id, p["text"])
                time.sleep(2)  # let async persistence land
                turn = telemetry(chat_id)["turn"] or {}
                ans = answer_text(chat_id)
                rec = {
                    "round": rnd + 1, "arm": arm, "probe": p["id"],
                    "expectSearch": p["expectSearch"], "http": code,
                    "wall_s": round(wall, 1),
                    "total_s": round((turn.get("total_ms") or 0) / 1000, 1),
                    "ttft_s": round((turn.get("ttft_ms") or 0) / 1000, 1),
                    "steps": turn.get("steps"), "tool_calls": turn.get("tool_calls"),
                    "sources": source_count(chat_id),
                    "answer_chars": len(ans),
                    # A 0-character answer is the regression this architecture
                    # kept producing; it must be countable, not inferred from
                    # a low character count.
                    "empty": len(ans.strip()) == 0,
                    "citations": ans.count("](#"),
                    # BOTH, because prompt_tokens alone cannot compare the arms.
                    # It is totalUsage.inputTokens — the SUM over steps — so a
                    # 6-18 step loop turn counts every step's prompt again and
                    # looks like it fed the model far more context than it did.
                    # last_prompt_tokens is the FINAL step: the actual answering
                    # prompt, and the only number comparable to a 1-step turn.
                    "prompt_tokens": turn.get("prompt_tokens"),
                    "last_prompt_tokens": turn.get("last_prompt_tokens"),
                    "skipSearch": turn.get("skipSearch"),
                    "needsSources": turn.get("needsSources"),
                    "crawler_mem_pct": mem_before,
                    "question": p["text"],
                    "answer": ans,
                }
                fh.write(json.dumps(rec) + "\n")
                fh.flush()
                print(f"  {arm:8} {p['id']} {rec['total_s']:6.1f}s steps={rec['steps']} "
                      f"tc={rec['tool_calls']} src={rec['sources']} chars={rec['answer_chars']} "
                      f"cite={rec['citations']} crawler={mem_before}%", flush=True)
    fh.close()
    print(f"\ndone -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
