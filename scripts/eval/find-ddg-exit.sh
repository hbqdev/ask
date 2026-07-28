#!/usr/bin/env bash
# Rotate the lab's Mullvad exit until DuckDuckGo actually returns results.
#
# WHY NOT TRUST unresponsive_engines: it reports what SearXNG *believes* about
# an engine, and that belief is sticky. SearXNG suspends an engine internally
# after a CAPTCHA and keeps reporting it as unresponsive on the NEW exit, so a
# rotation that genuinely fixed DDG still looks broken. The reverse also
# happens: an engine absent from the list can still return nothing.
#
# So the test here is the only one that means anything — an isolated
# `engines=duckduckgo` query, counting actual result rows. And SearXNG is
# restarted after every rotation to drop its cached suspensions, otherwise the
# first probe on a fresh exit re-reports the OLD exit's CAPTCHA.
#
# ONE QUERY, REUSED. The same string every attempt, deliberately: a rotating
# set of queries from a rotating set of IPs is exactly the pattern that gets an
# address flagged.
set -uo pipefail

cd /home/nightfury/selfhosted/ask

SEARX=http://192.168.50.231:3743
Q="linux+kernel+latest+release"
MAX="${1:-8}"
SETTLE="${SETTLE:-8}"

probe() { # -> "<count>|<unresponsive>"
  curl -s --max-time 45 "$SEARX/search?q=$Q&format=json&engines=duckduckgo" 2>/dev/null |
    python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('0|no-json'); raise SystemExit
print('%d|%s' % (len(d.get('results',[])), d.get('unresponsive_engines') or 'none'))
" 2>/dev/null || echo "0|probe-failed"
}

exit_ip() { docker exec ask-gluetun-lab wget -qO- --timeout=15 https://ipinfo.io/ip 2>/dev/null; }

for n in $(seq 1 "$MAX"); do
  IP=$(exit_ip)
  R=$(probe); COUNT="${R%%|*}"; WHY="${R#*|}"
  printf 'attempt %-2s exit=%-16s ddg_results=%-3s %s\n' "$n" "${IP:-?}" "$COUNT" "$WHY"

  if [ "${COUNT:-0}" -gt 0 ] 2>/dev/null; then
    echo
    echo "FOUND: duckduckgo returns $COUNT results on exit $IP"
    exit 0
  fi

  [ "$n" = "$MAX" ] && break
  ./fleet-boot/rotate-mullvad.sh rotate ask-lab --clear-health >/dev/null 2>&1
  # Rotation reconnects in place, so the namespace survives and searxng keeps
  # running — but with stale engine suspensions. Restart it to clear them.
  docker restart ask-searxng-lab >/dev/null 2>&1
  for _ in $(seq 1 24); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 $SEARX/ 2>/dev/null)" = "200" ] && break
    sleep 5
  done
  sleep "$SETTLE"
done

echo
echo "EXHAUSTED: no exit in $MAX attempts returned duckduckgo results"
exit 1
