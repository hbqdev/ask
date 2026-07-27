#!/usr/bin/env bash
# Manage the Mullvad exit IP for each gluetun-fronted service.
#
# WHY NOT `docker restart gluetun`: SearXNG and degoog run with
# `network_mode: service:gluetun`, so restarting or recreating gluetun leaves
# them "running" with a dead namespace — verified: the LAN UI returns 000 until
# the dependent container is force-recreated. Two consequences shape this
# script:
#   * `rotate` goes through gluetun's control server, which reconnects the
#     tunnel in place. The namespace survives and nothing else needs touching.
#   * `pin` and `city` change env, which REQUIRES a recreate, so they restart
#     the dependent service afterwards. That is why they are separate verbs.
#
# A NEW IP DOES NOT UNBLOCK ENGINES BY ITSELF. Ask's engine health gate
# suspends by ENGINE NAME with a 30-minute cooldown (lib/search/
# engine-health.ts), so brave stays suspended on the new IP until it expires.
# --clear-health drops those keys, which is almost always what you want after
# rotating: the suspensions were evidence about the OLD address.
#
# Rotate on a schedule or after a block spike, NOT per search. The same query
# pattern from a rapid succession of IPs in one ASN is a stronger bot signal
# than steady traffic from one address.
#
# USAGE
#   rotate-mullvad.sh status                     # current exit IP for everything
#   rotate-mullvad.sh rotate ask-staging --clear-health
#   rotate-mullvad.sh rotate all
#   rotate-mullvad.sh servers us-chi             # what hostnames exist
#   rotate-mullvad.sh pin ask-staging us-chi-wg-305
#   rotate-mullvad.sh city ask-staging us-nyc    # repool to another city
#   rotate-mullvad.sh health ask-staging         # suspended engines, no changes
#
# FLAGS
#   --clear-health   also drop enginehealth:* for that stack (rotate/pin/city)
#   --dry-run        print what would happen, change nothing
#
set -uo pipefail

RESIDENTIAL_IP=73.162.193.80
ASK=/home/nightfury/selfhosted/ask
DEGOOG=/home/nightfury/selfhosted/degoog
PUBLIC_SEARXNG=/home/nightfury/selfhosted/searxng

ASK_BASE="-f docker-compose.yaml -f docker-compose.vpn.yaml"
ASK_STAGING="-f docker-compose.yaml -f docker-compose.admin-feature.yaml -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml"

# name | gluetun container | redis (engine health, or -) | dir | compose args | project | dependent svc | env var for the server pool
TARGETS=(
  "ask-prod|ask-gluetun|ask-redis|$ASK|$ASK_BASE|ask-stack|searxng|MULLVAD_SERVER"
  "ask-staging|ask-gluetun-admin-feature|ask-redis-admin-feature|$ASK|$ASK_STAGING|ask-stack-admin-feature|searxng|MULLVAD_SERVER_STAGING"
  "degoog|degoog-gluetun|-|$DEGOOG|-f docker-compose.yaml -f docker-compose.vpn.yaml|degoog|degoog|MULLVAD_SERVER_DEGOOG"
  "public-searxng|searxng-gluetun|-|$PUBLIC_SEARXNG|-f docker-compose.yaml -f docker-compose.vpn.yaml|searxng|searxng|MULLVAD_SERVER_PUBLIC"
)

VERB="${1:-status}"; shift || true
ARG1="" ; ARG2=""
CLEAR_HEALTH=false ; DRY_RUN=false
for a in "$@"; do
  case "$a" in
    --clear-health) CLEAR_HEALTH=true ;;
    --dry-run)      DRY_RUN=true ;;
    -*)             echo "unknown flag: $a" >&2; exit 2 ;;
    *)              if [[ -z "$ARG1" ]]; then ARG1="$a"; else ARG2="$a"; fi ;;
  esac
done

lookup() { # name -> entry, or empty
  local want="$1"
  for e in "${TARGETS[@]}"; do
    [[ "${e%%|*}" == "$want" ]] && { echo "$e"; return 0; }
  done
  return 1
}

exit_ip() { docker exec "$1" wget -qO- --timeout=15 https://ipinfo.io/ip 2>/dev/null; }

current_server() { # gluetun container -> SERVER_HOSTNAMES as configured
  docker exec "$1" printenv SERVER_HOSTNAMES 2>/dev/null
}

ctl() { # container, method, path, body
  local c="$1" m="$2" p="$3" b="${4:-}"
  if [[ "$m" == "PUT" ]]; then
    docker exec "$c" wget -qO- --timeout=10 --method=PUT --body-data="$b" \
      --header='Content-Type: application/json' "http://127.0.0.1:8000$p" 2>/dev/null
  else
    docker exec "$c" wget -qO- --timeout=10 "http://127.0.0.1:8000$p" 2>/dev/null
  fi
}

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

clear_health() { # redis container
  [[ "$1" == "-" ]] && { echo "     (no engine health for this stack)"; return; }
  if $DRY_RUN; then echo "     [dry-run] would clear enginehealth:*"; return; fi
  local n
  n=$(docker exec "$1" sh -c \
    'redis-cli --scan --pattern "enginehealth:*" | while IFS= read -r k; do redis-cli del "$k" >/dev/null; echo x; done' \
    2>/dev/null | wc -l)
  echo "     cleared $n engine-health keys"
}

# Wait for egress rather than sleeping a fixed time: a reconnect that silently
# failed would otherwise look like a rotation that happened to keep its IP.
wait_egress() {
  local c="$1" ip=""
  for _ in $(seq 1 20); do
    sleep 3
    ip="$(exit_ip "$c")"
    [[ -n "$ip" ]] && break
  done
  echo "$ip"
}

check_egress() { # name, ip -> 0 ok
  local name="$1" ip="$2"
  if [[ -z "$ip" ]]; then echo "     !! no egress — tunnel did not come back"; return 1; fi
  if [[ "$ip" == "$RESIDENTIAL_IP" ]]; then echo "     !! RESIDENTIAL ip — kill switch is not holding"; return 1; fi
  return 0
}

failed=()

case "$VERB" in

status)
  printf '%-16s %-34s %-18s %s\n' "STACK" "SERVER POOL" "EXIT IP" "STATE"
  for e in "${TARGETS[@]}"; do
    IFS='|' read -r name gluetun redis dir compose proj dep envvar <<<"$e"
    if ! running "$gluetun"; then
      printf '%-16s %-34s %-18s %s\n' "$name" "-" "-" "container down"; continue
    fi
    pool="$(current_server "$gluetun")"
    ip="$(exit_ip "$gluetun")"
    state="ok"
    [[ -z "$ip" ]] && state="NO EGRESS"
    [[ "$ip" == "$RESIDENTIAL_IP" ]] && state="LEAKING (residential)"
    printf '%-16s %-34s %-18s %s\n' "$name" "${pool:0:33}" "${ip:--}" "$state"
  done
  ;;

health)
  entry="$(lookup "${ARG1:-ask-staging}")" || { echo "unknown stack: $ARG1" >&2; exit 2; }
  IFS='|' read -r name gluetun redis dir compose proj dep envvar <<<"$entry"
  [[ "$redis" == "-" ]] && { echo "$name has no engine health store"; exit 0; }
  now=$(date +%s000)
  docker exec "$redis" sh -c \
    'redis-cli --scan --pattern "enginehealth:*" | grep -v __known | while IFS= read -r k; do printf "%s\t%s\n" "$k" "$(redis-cli get "$k")"; done' \
    2>/dev/null | NOW="$now" python3 -c "
import sys, os, json
now=int(os.environ['NOW'])
rows=[]
for line in sys.stdin:
    if '\t' not in line: continue
    k,v=line.rstrip('\n').split('\t',1)
    try: d=json.loads(v)
    except: continue
    until=d.get('suspendedUntil',0)
    rows.append((k.replace('enginehealth:',''), d.get('breaches',0), until, max(0,(until-now)//1000)))
if not rows:
    print('no engine health recorded — nothing suspended'); raise SystemExit
rows.sort(key=lambda r:-r[2])
print('%-24s %-9s %s' % ('ENGINE','BREACHES','SUSPENDED'))
for name,b,until,left in rows:
    print('%-24s %-9s %s' % (name, b, ('%dm %ds' % (left//60, left%60)) if left>0 else '-'))
"
  ;;

servers)
  city="${ARG1:-}"
  gluetun="ask-gluetun-admin-feature"
  running "$gluetun" || gluetun="ask-gluetun"
  running "$gluetun" || { echo "no gluetun container running to read the server list from" >&2; exit 1; }
  if [[ -z "$city" ]]; then
    echo "wireguard servers per US city (pass a city for hostnames):"
    docker exec "$gluetun" sh -c \
      'grep -o "us-[a-z]\{3\}-wg-[0-9]*" /gluetun/servers/mullvad.json | sed "s/-wg-[0-9]*//" | sort | uniq -c | sort -rn'
  else
    # Mullvad does NOT number from 001 per city (us-chi starts at 201/301) and
    # gluetun falls back silently on a hostname that does not exist, so always
    # read the real list before pinning.
    docker exec "$gluetun" sh -c \
      "grep -o '${city}-wg-[0-9]*' /gluetun/servers/mullvad.json | sort -u | tr '\n' ' '"
    echo
  fi
  ;;

rotate)
  want="${ARG1:-all}"
  for e in "${TARGETS[@]}"; do
    IFS='|' read -r name gluetun redis dir compose proj dep envvar <<<"$e"
    [[ "$want" != "all" && "$want" != "$name" ]] && continue
    echo
    echo "-- $name ($gluetun)"
    running "$gluetun" || { echo "     !! not running"; failed+=("$name:down"); continue; }
    before="$(exit_ip "$gluetun")"
    echo "     before: ${before:-unknown}   pool: $(current_server "$gluetun")"
    if $DRY_RUN; then echo "     [dry-run] would stop+start the tunnel"; continue; fi
    if ! ctl "$gluetun" PUT /v1/vpn/status '{"status":"stopped"}' >/dev/null; then
      echo "     !! control server refused (is gluetun-auth.toml mounted?)"
      failed+=("$name:ctl"); continue
    fi
    sleep 3
    ctl "$gluetun" PUT /v1/vpn/status '{"status":"running"}' >/dev/null
    after="$(wait_egress "$gluetun")"
    check_egress "$name" "$after" || { failed+=("$name:egress"); continue; }
    if [[ "$after" == "$before" ]]; then
      echo "     after:  $after  (same — pool may hold one host; see \`servers\`/\`city\`)"
    else
      echo "     after:  $after  (rotated)"
    fi
    $CLEAR_HEALTH && clear_health "$redis"
  done
  ;;

pin|city)
  entry="$(lookup "$ARG1")" || { echo "usage: $0 $VERB <stack> <value>" >&2; exit 2; }
  [[ -z "$ARG2" ]] && { echo "usage: $0 $VERB <stack> <value>" >&2; exit 2; }
  IFS='|' read -r name gluetun redis dir compose proj dep envvar <<<"$entry"

  if [[ "$VERB" == "city" ]]; then
    list=$(docker exec "$gluetun" sh -c \
      "grep -o '${ARG2}-wg-[0-9]*' /gluetun/servers/mullvad.json | sort -u | head -6 | tr '\n' ','" 2>/dev/null)
    value="${list%,}"
    [[ -z "$value" ]] && { echo "no wireguard servers found for city '$ARG2'" >&2; exit 1; }
  else
    ok=$(docker exec "$gluetun" sh -c \
      "grep -c '\"$ARG2\"' /gluetun/servers/mullvad.json" 2>/dev/null)
    [[ "${ok:-0}" == "0" ]] && { echo "hostname '$ARG2' is not in mullvad's server list — check \`$0 servers\`" >&2; exit 1; }
    value="$ARG2"
  fi

  echo "-- $name: $envvar=$value"
  if $DRY_RUN; then echo "   [dry-run] would recreate gluetun and $dep"; exit 0; fi

  # env change => recreate => the dependent container's namespace goes stale,
  # so it is force-recreated straight after. This is the whole reason `rotate`
  # exists as a separate verb.
  ( cd "$dir" && env "$envvar=$value" docker compose $compose -p "$proj" up -d gluetun ) >/dev/null 2>&1
  after="$(wait_egress "$gluetun")"
  check_egress "$name" "$after" || { echo "FAILED"; exit 1; }
  ( cd "$dir" && env "$envvar=$value" docker compose $compose -p "$proj" up -d --force-recreate "$dep" ) >/dev/null 2>&1
  echo "   exit ip: $after"
  echo "   NOTE: $envvar is set for THIS invocation only. Put it in the stack's"
  echo "         .env, or edit the compose default, to survive the next up -d."
  $CLEAR_HEALTH && clear_health "$redis"
  ;;

*)
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac

echo
if ((${#failed[@]})); then echo "FAILED: ${failed[*]}"; exit 1; fi
exit 0
