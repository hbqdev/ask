#!/usr/bin/env python3
"""Harvest per-turn telemetry and answers for browser-driven staging/lab chats.

WHY THIS IS SEPARATE FROM THE DRIVER. compare-instances.py posts to /api/chat
directly, which cannot run against staging at all — staging requires a real
session, and the whole point of this comparison was real user experience
through the browser. So the browser drives the turns and this reads back what
the servers recorded, keyed by chat id. Nothing here re-runs a question.

WHAT IT CORRECTS FROM THE EARLIER HARNESS. compare-instances.py counted
citations as `answer.count("](#")` over `parts.text_text`. That column is the
model's RAW output, and processCitations runs at RENDER time — it turns a bare
`[3]` into a link when the turn has exactly one citation map, which is every
pipeline turn by construction. So the old count scored a correctly-cited
pipeline answer as having zero citations. Both forms are counted here, and
reported separately, because the difference between them is the difference
between "the model anchored it" and "the renderer resolved it".

Usage:
  harvest-pairs.py --pairs pairs.json --out results/browser-pairs.jsonl

pairs.json: [{"chat": 7, "staging": "<chatId>", "lab": "<chatId>"}, ...]
"""
import argparse, json, re, subprocess
from pathlib import Path

INSTANCES = {
    "staging": {"pg": "ask-postgres-admin-feature", "redis": "ask-redis-admin-feature"},
    "lab": {"pg": "ask-postgres-lab", "redis": "ask-redis-lab"},
}

# `[3](#anchor)` — the model anchored it itself.
ANCHORED = re.compile(r"\]\(#")
# A bare `[3]` NOT followed by `(`. The renderer resolves these when the turn
# has exactly one citation map; excluding markdown links is what the negative
# lookahead is for.
BARE = re.compile(r"\[\d{1,2}\](?!\()")


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout or ""


def psql(inst, sql):
    return sh(["docker", "exec", INSTANCES[inst]["pg"], "psql", "-U", "morphic",
               "-d", "morphic", "-tAc", sql]).strip()


def turns(inst, chat_id):
    """One row per CONVERSATIONAL TURN, oldest first.

    A turn opens with a user message and owns every assistant part until the
    next user message. Grouping any other way misaligns the two instances,
    because the two architectures persist different numbers of assistant
    messages for the same turn: measured on chat 7 turn 2, staging wrote a
    52-char inter-step text AND a 5,575-char answer as separate assistant
    messages, while the pipeline wrote one. Keying on assistant text parts
    therefore shifted staging's answers by one from turn 2 onward and compared
    each question against the answer to a different one.

    Returned as JSON from postgres, not delimited text: answers are markdown
    and full of newlines, and a line-split parse shattered every multi-line
    answer into phantom empty turns (89 of them for an 8-turn chat).
    """
    raw = psql(inst,
        "SELECT COALESCE(json_agg(json_build_object("
        "  'mid', m.id, 'role', m.role, 'ord', COALESCE(p.\"order\", 0),"
        "  'type', COALESCE(p.type,''), 'text', COALESCE(p.text_text,''),"
        "  'nsrc', CASE WHEN p.type='tool-search'"
        "    AND json_typeof(p.tool_search_output->'results')='array'"
        "    THEN json_array_length(p.tool_search_output->'results') ELSE 0 END"
        ") ORDER BY m.created_at ASC, COALESCE(p.\"order\", 0) ASC), '[]') "
        "FROM messages m LEFT JOIN parts p ON p.message_id = m.id "
        f"WHERE m.chat_id='{chat_id}';")
    try:
        rows = json.loads(raw) if raw.strip() else []
    except Exception:
        return []

    # Keyed on MESSAGE ID, not on row. The LEFT JOIN emits one row per PART, so
    # a user message carrying two parts would otherwise open two turns —
    # chat 7 reported 12 turns for a 9-turn thread that way, which shifted
    # every subsequent staging/lab comparison by a turn or more.
    out, cur, seen_user = [], None, None
    for r in rows:
        if r["role"] == "user":
            if r["mid"] != seen_user:
                seen_user = r["mid"]
                cur = {"question": r["text"], "chunks": [], "sources": 0}
                out.append(cur)
            elif cur is not None and r["text"].strip():
                # Continuation part of the same user message.
                cur["question"] = (cur["question"] + "\n" + r["text"]).strip()
            continue
        if cur is None:
            continue  # assistant part before any user message; not a turn
        if r["type"] == "text" and r["text"].strip():
            cur["chunks"].append(r["text"])
        cur["sources"] += r.get("nsrc") or 0

    # Joined rather than last-wins: the inter-step text IS part of what the
    # user was shown, and dropping it would flatter the loop's answer length.
    #
    # DUPLICATE DETECTION. A turn whose question was already asked earlier in
    # the same thread is NOT comparable evidence: the model is answering with a
    # history that already contains the question and its answer, which is a
    # different task from answering it once. Chat 7 acquired six such turns
    # when a power cut orphaned one question and the driver batch then ran the
    # same three questions twice. Flagged rather than dropped here, so the
    # analyzer can exclude them and SAY it excluded them.
    seen_q = set()
    for t in out:
        t["text"] = "\n\n".join(t["chunks"])
        t["parts"] = len(t["chunks"])
        del t["chunks"]
        key = " ".join(t["question"].split()).lower()
        t["dup"] = key in seen_q
        seen_q.add(key)
    return out


def latency(inst, chat_id):
    """Every [latency] line for this chat, OLDEST FIRST — one per turn.

    Two traps here, both of which produced wrong tables before being found:

      * latency-store.ts pushes with lPush, so the list is NEWEST first while
        the postgres side is ordered created_at ASC. Joining them positionally
        without reversing paired turn 1's answer with the last turn's timing —
        it reported lab turn 1 at 13.7s when that turn actually took 88.5s.
      * The same list also carries `[latency:search] ` lines, which are per
        SEARCH and several per turn. Matching on the `[latency] ` prefix
        exactly is what keeps this one-row-per-turn.
    """
    raw = sh(["docker", "exec", INSTANCES[inst]["redis"], "redis-cli",
              "lrange", "latency:log", "0", "-1"])
    rows = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("[latency] "):
            continue
        try:
            t = json.loads(line.split(" ", 1)[1])
        except Exception:
            continue
        if t.get("chatId") == chat_id:
            rows.append(t)
    rows.reverse()
    return rows


def summarise(inst, chat_id):
    texts = turns(inst, chat_id)
    lat = latency(inst, chat_id)
    rows = []
    for i, t in enumerate(texts):
        # Positional join: both lists are ordered by turn and a turn that
        # produced no [latency] line (a hard abort) would shift them. Guarded
        # by length rather than assumed.
        tel = lat[i] if i < len(lat) else {}
        stream = tel.get("stream", {}) or {}
        text = t["text"]
        rows.append({
            "turn": i + 1,
            "question": t.get("question", ""),
            "total_s": round((tel.get("total_ms") or 0) / 1000, 1),
            "steps": tel.get("steps"),
            "tool_calls": tel.get("tool_calls"),
            "sources": t.get("sources", 0),
            "answer_parts": t.get("parts", 0),
            "dup": t.get("dup", False),
            "injected": tel.get("pipeline_injected"),
            "retrieval_s": round((tel.get("pipeline_retrieval_ms") or 0) / 1000, 1)
                           if tel.get("pipeline_retrieval_ms") is not None else None,
            "chars": len(text),
            "empty": not text.strip(),
            "cite_anchored": len(ANCHORED.findall(text)),
            "cite_bare": len(BARE.findall(text)),
            "skipSearch": tel.get("skipSearch"),
            "last_prompt_tokens": tel.get("last_prompt_tokens"),
            "stall_retries": tel.get("stall_retries"),
            "wrote_prose": "text-start" in stream,
            "aborted": "abort" in stream,
            "text": text,
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--out", default="scripts/eval/results/browser-pairs.jsonl")
    # Emitted in judge-flow-arms.py's shape so quality can be scored with the
    # SAME blind pairwise protocol the architecture A/B used — sides swapped,
    # a win only when both orderings agree, judged by a model that is not the
    # one under test. Speed tables alone cannot tell a faster system from a
    # worse one.
    ap.add_argument("--judge-out", default="scripts/eval/results/browser-judgeinput.jsonl")
    a = ap.parse_args()
    judge_rows = []

    pairs = json.loads(Path(a.pairs).read_text())
    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with out_path.open("w") as fh:
        for pair in pairs:
            per = {inst: summarise(inst, pair[inst]) for inst in ("staging", "lab")}
            n = max(len(per["staging"]), len(per["lab"]))
            print(f"\n=== chat {pair['chat']} ({n} turns) ===")
            print(f"{'turn':>4} {'staging_s':>10} {'lab_s':>8} {'s_src':>6} {'l_src':>6} "
                  f"{'s_ch':>6} {'l_ch':>6} {'s_cite':>7} {'l_cite':>7}")
            for i in range(n):
                s = per["staging"][i] if i < len(per["staging"]) else {}
                l = per["lab"][i] if i < len(per["lab"]) else {}
                fh.write(json.dumps({"chat": pair["chat"], "turn": i + 1,
                                     "staging": s, "lab": l}) + "\n")
                # Only judge turns where BOTH sides answered. An empty answer
                # is a failure the table above already reports; feeding it to
                # the judge would count the same defect twice.
                if (s.get("text", "").strip() and l.get("text", "").strip()
                        and not s.get("dup") and not l.get("dup")):
                    probe = f"c{pair['chat']}t{i+1}"
                    # The question comes off the persisted USER message, so it
                    # is the text the instance actually answered rather than
                    # what the script meant to send.
                    q = s.get("question") or l.get("question") or probe
                    for arm, row in (("staging", s), ("lab", l)):
                        judge_rows.append({"arm": arm, "probe": probe,
                                           "question": q, "answer": row["text"]})
                sc = (s.get("cite_anchored", 0) or 0) + (s.get("cite_bare", 0) or 0)
                lc = (l.get("cite_anchored", 0) or 0) + (l.get("cite_bare", 0) or 0)
                print(f"{i+1:>4} {s.get('total_s',0):>10} {l.get('total_s',0):>8} "
                      f"{s.get('sources',0):>6} {l.get('sources',0):>6} "
                      f"{s.get('chars',0):>6} {l.get('chars',0):>6} {sc:>7} {lc:>7}"
                      + ("  <-- EMPTY" if s.get("empty") or l.get("empty") else "")
                      + ("  <-- DUP (question repeated; excluded)"
                         if s.get("dup") or l.get("dup") else ""))
    judge_path = Path(a.judge_out)
    judge_path.parent.mkdir(parents=True, exist_ok=True)
    judge_path.write_text("".join(json.dumps(r) + "\n" for r in judge_rows))
    print(f"\nwrote {out_path}")
    print(f"wrote {judge_path} ({len(judge_rows)//2} judgeable pairs)")
    print(f"  judge with: scripts/eval/judge-flow-arms.py {judge_path} --baseline staging")


if __name__ == "__main__":
    main()
