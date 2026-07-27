#!/usr/bin/env python3
"""
Suspend degoog engines that upstream is currently blocking, then restore them.

Why this exists: degoog has no per-engine backoff. sentinel.ts classifies a
breach (rate_limited / blocked / captcha) and throws, but engines/registry.ts
only caches engine *types* — nothing suspends a failing engine. So every search
re-queries an engine that is already refusing us. On 2026-07-25 that turned 23
test searches into 46 Brave 429s, and because degoog shares one egress IP with
SearXNG and ordinary browsing, Brave went down for those too.

degoog runs a third-party prebuilt image, so its source is not ours to patch.
This drives its own supported settings API instead:
    POST /api/settings/auth            {"password": ...}  -> settings-token cookie
    GET  /api/settings/default-engines                    -> {key: bool}
    POST /api/settings/default-engines {key: bool}

Safety rules, in order of importance:
  1. Only ever re-enable an engine THIS script disabled. Engines the operator
     turned off by hand (duckduckgo, lemmy, ...) are never touched.
  2. Never suspend the last healthy general engine — a degraded search beats no
     search. Better to keep hitting a wall than to return nothing.
  3. Do nothing at all on any error. A watchdog that breaks search to protect
     search is worse than the problem.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEGOOG_DIR = Path("/home/nightfury/selfhosted/degoog")
BASE_URL = os.environ.get("DEGOOG_URL", "http://localhost:4444")
CONTAINER = os.environ.get("DEGOOG_CONTAINER", "degoog-degoog-1")
STATE_FILE = Path(
    os.environ.get("DEGOOG_WATCHDOG_STATE", "/home/nightfury/logs/degoog-watchdog.json")
)

# Suspend an engine after this many breaches inside the look-back window.
# Deliberately not 1: a single 429 is noise, a sustained run is a wall.
FAIL_THRESHOLD = int(os.environ.get("DEGOOG_FAIL_THRESHOLD", "5"))
LOOKBACK_MINUTES = int(os.environ.get("DEGOOG_LOOKBACK_MINUTES", "10"))
COOLDOWN_MINUTES = int(os.environ.get("DEGOOG_COOLDOWN_MINUTES", "30"))

# Engines that carry general web results. At least one must stay enabled.
CORE_ENGINES = {
    "degoog-org-official-extensions-google-engine",
    "degoog-org-official-extensions-bing-engine",
    "degoog-org-official-extensions-brave-engine",
    "degoog-org-official-extensions-startpage-engine",
    "degoog-org-official-extensions-ecosia-engine",
    "degoog-org-official-extensions-duckduckgo-engine",
}

# How degoog names an engine in its logs -> the settings key it toggles.
LOG_NAME_TO_KEY = {
    "google": "degoog-org-official-extensions-google-engine",
    "brave search": "degoog-org-official-extensions-brave-engine",
    "brave": "degoog-org-official-extensions-brave-engine",
    "startpage": "degoog-org-official-extensions-startpage-engine",
    "bing": "degoog-org-official-extensions-bing-engine",
    "duckduckgo": "degoog-org-official-extensions-duckduckgo-engine",
    "ecosia": "degoog-org-official-extensions-ecosia-engine",
}

# "Brave Search failed after 376ms status=rate_limited"
BREACH_RE = re.compile(
    r"^(?P<engine>[A-Za-z][A-Za-z ]{1,24}?) failed after \d+ms status=(?P<status>\w+)",
    re.MULTILINE,
)
# Only these mean "upstream is refusing us". A parse error or timeout is our
# problem or a transient, and suspending for those would hide real breakage.
BLOCKING = {"rate_limited", "blocked", "captcha"}


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


def read_password() -> str | None:
    env = DEGOOG_DIR / ".env"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        if line.startswith("DEGOOG_SETTINGS_PASSWORDS="):
            return line.split("=", 1)[1].strip().split(",")[0]
    return None


class Degoog:
    """Authenticated client for degoog's settings API."""

    def __init__(self, password: str):
        self._cj = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._cj)
        )
        self._password = password

    def login(self) -> bool:
        req = urllib.request.Request(
            f"{BASE_URL}/api/settings/auth",
            data=json.dumps({"password": self._password}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self._opener.open(req, timeout=20) as resp:
            ok = resp.status == 200
        return ok and any(c.name == "settings-token" for c in self._cj)

    def get_engines(self) -> dict[str, bool]:
        with self._opener.open(
            f"{BASE_URL}/api/settings/default-engines", timeout=20
        ) as resp:
            payload = json.load(resp)
        inner = payload.get("engines")
        return inner if isinstance(inner, dict) else payload

    def set_engines(self, patch: dict[str, bool]) -> None:
        req = urllib.request.Request(
            f"{BASE_URL}/api/settings/default-engines",
            data=json.dumps(patch).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self._opener.open(req, timeout=20) as resp:
            if resp.status not in (200, 204):
                raise RuntimeError(f"set_engines returned HTTP {resp.status}")


def recent_breaches(minutes: int) -> dict[str, int]:
    """Count blocking breaches per settings key in the last `minutes`."""
    out = subprocess.run(
        ["docker", "logs", "--since", f"{minutes}m", CONTAINER],
        capture_output=True,
        text=True,
        timeout=60,
    )
    counts: dict[str, int] = {}
    for m in BREACH_RE.finditer(out.stdout + out.stderr):
        if m.group("status").lower() not in BLOCKING:
            continue
        key = LOG_NAME_TO_KEY.get(m.group("engine").strip().lower())
        if key:
            counts[key] = counts.get(key, 0) + 1
    return counts


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"suspended": {}}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)


def run_once(dry_run: bool) -> int:
    password = read_password()
    if not password:
        log("ERROR no DEGOOG_SETTINGS_PASSWORDS in degoog/.env — doing nothing")
        return 1

    client = Degoog(password)
    if not client.login():
        log("ERROR settings login failed — doing nothing")
        return 1

    engines = client.get_engines()
    state = load_state()
    suspended: dict[str, float] = state.get("suspended", {})
    now = time.time()
    patch: dict[str, bool] = {}

    # 1. Restore anything whose cooldown has expired. Only ever ours.
    for key, until in list(suspended.items()):
        if now >= until:
            if engines.get(key) is False:
                patch[key] = True
                log(f"RESTORE {key} (cooldown expired)")
            suspended.pop(key, None)

    # 2. Suspend engines upstream is actively refusing.
    counts = recent_breaches(LOOKBACK_MINUTES)
    for key, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        if n < FAIL_THRESHOLD or key in suspended or engines.get(key) is not True:
            continue

        # Never take out the last general engine still standing.
        healthy = {
            k
            for k in CORE_ENGINES
            if engines.get(k) is True and k not in suspended and k not in patch
        }
        if key in healthy and len(healthy) <= 1:
            log(f"KEEP {key}: {n} breaches, but it is the last healthy core engine")
            continue

        patch[key] = False
        suspended[key] = now + COOLDOWN_MINUTES * 60
        log(f"SUSPEND {key}: {n} breaches in {LOOKBACK_MINUTES}m "
            f"(restores in {COOLDOWN_MINUTES}m)")

    if not patch:
        active = ", ".join(sorted(suspended)) or "none"
        log(f"no change (suspended: {active})")
        return 0

    if dry_run:
        log(f"DRY RUN would apply: {json.dumps(patch)}")
        return 0

    client.set_engines(patch)
    state["suspended"] = suspended
    save_state(state)
    log(f"applied {json.dumps(patch)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="report, change nothing")
    ap.add_argument("--loop", type=int, metavar="SECONDS", help="run forever")
    args = ap.parse_args()

    if not args.loop:
        try:
            return run_once(args.dry_run)
        except Exception as exc:  # never let the watchdog itself break anything
            log(f"ERROR {type(exc).__name__}: {exc}")
            return 1

    while True:
        try:
            run_once(args.dry_run)
        except Exception as exc:
            log(f"ERROR {type(exc).__name__}: {exc}")
        time.sleep(args.loop)


if __name__ == "__main__":
    sys.exit(main())
