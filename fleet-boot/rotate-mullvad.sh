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
#   rotate-mullvad.sh servers                    # US cities + who hosts them
#   rotate-mullvad.sh servers us-chi             # hostnames + provider
#   rotate-mullvad.sh pin ask-staging us-chi-wg-305
#   rotate-mullvad.sh city ask-staging us-nyc    # repool to another city
#   rotate-mullvad.sh city ask-prod us-nyc --isp Tzulo
#   rotate-mullvad.sh health ask-staging         # suspended engines, no changes
#
# ON PROVIDERS: a city can host four of them (Dallas carries M247, DataPacket,
# HostRoyale and Tzulo) and they do NOT behave alike against search engines.
# Without --isp, `city` takes the lowest-numbered hostnames, which is an
# arbitrary provider rather than a chosen one. This is optionality, not a
# recommendation: no provider is immune, and the Atlanta addresses we burnt
# through our own search volume were Tzulo.
#
# FLAGS
#   --clear-health   also drop enginehealth:* for that stack (rotate/pin/city)
#   --dry-run        print what would happen, change nothing
#   --isp NAME       restrict city/servers to one hosting provider
#   --count N        how many hosts to put in the pool (default 6)
#
set -uo pipefail

RESIDENTIAL_IP=73.162.193.80
ASK=/home/nightfury/selfhosted/ask
DEGOOG=/home/nightfury/selfhosted/degoog
PUBLIC_SEARXNG=/home/nightfury/selfhosted/searxng

ASK_BASE="-f docker-compose.yaml -f docker-compose.vpn.yaml"
ASK_STAGING="-f docker-compose.yaml -f docker-compose.admin-feature.yaml -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml"
ASK_LAB="-f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml"
# The per-stack degoog instances all share one parameterised overlay; which
# instance you get comes from the project name plus DEGOOG_INSTANCE/DEGOOG_PORT
# in the environment, not from a different file.
DEGOOG_INSTANCE_FILES="-f docker-compose.yaml -f docker-compose.vpn.yaml -f docker-compose.instance.yaml"

# name | gluetun container | redis (engine health, or -) | dir | compose args | project | dependent svc | env var for the server pool
#
# The env var MUST match the one that stack's compose actually interpolates
# into SERVER_HOSTNAMES. degoog and public-searxng previously read
# MULLVAD_SERVER_DEGOOG / MULLVAD_SERVER_PUBLIC here while their composes read
# plain ${MULLVAD_SERVER} — so `city` and `pin` set a variable nothing consumed,
# gluetun silently fell back to the compose default, and the script still
# printed an exit IP as though the repool had worked. Three stacks sharing the
# name MULLVAD_SERVER is safe because each runs `docker compose` from its own
# directory with its own .env; the name is scoped by cwd, not global.
TARGETS=(
  "ask-prod|ask-gluetun|ask-redis|$ASK|$ASK_BASE|ask-stack|searxng|MULLVAD_SERVER"
  "ask-staging|ask-gluetun-admin-feature|ask-redis-admin-feature|$ASK|$ASK_STAGING|ask-stack-admin-feature|searxng|MULLVAD_SERVER_STAGING"
  "ask-lab|ask-gluetun-lab|ask-redis-lab|$ASK|$ASK_LAB|ask-stack-lab|searxng|MULLVAD_SERVER_LAB"
  "degoog|degoog-gluetun|-|$DEGOOG|-f docker-compose.yaml -f docker-compose.vpn.yaml|degoog|degoog|MULLVAD_SERVER"
  # Per-stack degoog instances (2026-07-28). Each has its own exit so one
  # stack's volume cannot get another's address rate-limited. They share
  # MULLVAD_SERVER_DEGOOG_INSTANCE only as a DEBUG pin — leave it empty in
  # normal operation, because pinning all three to one hostname would put three
  # WireGuard peers with the same account key on one server, where they fight
  # over the route.
  "degoog-prod|degoog-gluetun-prod|-|$DEGOOG|$DEGOOG_INSTANCE_FILES|degoog-prod|degoog|MULLVAD_SERVER_DEGOOG_INSTANCE"
  "degoog-staging|degoog-gluetun-staging|-|$DEGOOG|$DEGOOG_INSTANCE_FILES|degoog-staging|degoog|MULLVAD_SERVER_DEGOOG_INSTANCE"
  "degoog-lab|degoog-gluetun-lab|-|$DEGOOG|$DEGOOG_INSTANCE_FILES|degoog-lab|degoog|MULLVAD_SERVER_DEGOOG_INSTANCE"
  "public-searxng|searxng-gluetun|-|$PUBLIC_SEARXNG|-f docker-compose.yaml -f docker-compose.vpn.yaml|searxng|searxng|MULLVAD_SERVER"
)

VERB="${1:-status}"; shift || true
ARG1="" ; ARG2=""
CLEAR_HEALTH=false ; DRY_RUN=false
ISP_FILTER="" ; POOL_SIZE=6
while (( $# )); do
  case "$1" in
    --clear-health) CLEAR_HEALTH=true ;;
    --dry-run)      DRY_RUN=true ;;
    --isp)          ISP_FILTER="${2:-}"; shift ;;
    --isp=*)        ISP_FILTER="${1#*=}" ;;
    --count)        POOL_SIZE="${2:-6}"; shift ;;
    --count=*)      POOL_SIZE="${1#*=}" ;;
    -*)             echo "unknown flag: $1" >&2; exit 2 ;;
    *)              if [[ -z "$ARG1" ]]; then ARG1="$1"; else ARG2="$1"; fi ;;
  esac
  shift
done

# City prefix (+ optional ISP) -> comma-separated hostname pool.
#
# Parses mullvad.json properly instead of grepping hostnames out of the raw
# text, because a city can host SEVERAL providers and the provider is the thing
# worth selecting on. Dallas carries M247, DataPacket, HostRoyale and Tzulo;
# `city degoog us-dal` would take the first six hostnames numerically and land
# on M247 every time, with no way to say otherwise.
#
# Uses python3 on the HOST (gluetun's image has no json tooling). Only `city`
# and `servers` need it — `rotate`, the verb cron runs, does not.
pool_for() { # gluetun-container, city-prefix, isp-or-empty, count
  docker exec "$1" cat /gluetun/servers/mullvad.json 2>/dev/null | python3 -c "
import sys, json
prefix, isp, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
hosts = sorted(
    s['hostname'] for s in d.get('servers', [])
    if s.get('vpn') == 'wireguard'
    and s.get('hostname', '').startswith(prefix + '-wg-')
    and (not isp or (s.get('isp') or '').lower() == isp.lower())
)
print(','.join(hosts[:n]))
" "$2" "$3" "$4" 2>/dev/null
}

lookup() { # name -> entry, or empty
  local want="$1"
  for e in "${TARGETS[@]}"; do
    [[ "${e%%|*}" == "$want" ]] && { echo "$e"; return 0; }
  done
  return 1
}

exit_ip() { docker exec "$1" wget -qO- --timeout=15 https://ipinfo.io/ip 2>/dev/null; }

current_server() { # gluetun container -> the effective server filter
  # Hostnames are empty by default now: every stack selects at random across a
  # whole country (SERVER_COUNTRIES), so reporting only SERVER_HOSTNAMES would
  # print a blank pool and read like a misconfiguration. Hostnames still win
  # when set, because `pin` and `city` set exactly that.
  local hosts countries
  hosts=$(docker exec "$1" printenv SERVER_HOSTNAMES 2>/dev/null)
  if [[ -n "$hosts" ]]; then echo "$hosts"; return; fi
  countries=$(docker exec "$1" printenv SERVER_COUNTRIES 2>/dev/null)
  echo "any:${countries:-?}"
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
  # Provider is shown because it is the axis worth choosing on: one city can
  # host four of them, and they do not behave alike against search engines.
  docker exec "$gluetun" cat /gluetun/servers/mullvad.json 2>/dev/null | \
    CITY="$city" ISP="$ISP_FILTER" python3 -c "
import sys, os, json
from collections import defaultdict
city, isp = os.environ.get('CITY',''), os.environ.get('ISP','')
d = json.load(sys.stdin)
srv = [s for s in d.get('servers', [])
       if s.get('vpn') == 'wireguard' and s.get('country') == 'USA'
       and (not isp or (s.get('isp') or '').lower() == isp.lower())]

if not city:
    by = defaultdict(lambda: defaultdict(int))
    for s in srv:
        by[s['hostname'].rsplit('-wg-', 1)[0]][s.get('isp') or '?'] += 1
    print('%-10s %-5s %s' % ('CITY', 'N', 'PROVIDERS'))
    for c in sorted(by, key=lambda k: -sum(by[k].values())):
        tot = sum(by[c].values())
        print('%-10s %-5d %s' % (c, tot,
              ', '.join('%s x%d' % kv for kv in sorted(by[c].items(), key=lambda kv: -kv[1]))))
    print()
    print('Pass a city for hostnames, e.g. \`servers us-nyc\`. Filter with --isp Tzulo.')
else:
    hosts = sorted((s['hostname'], s.get('isp') or '?') for s in srv
                   if s['hostname'].startswith(city + '-wg-'))
    if not hosts:
        print('no wireguard servers for %s%s' % (city, ' on isp ' + isp if isp else ''))
    else:
        print('%-18s %s' % ('HOSTNAME', 'PROVIDER'))
        for h, i in hosts:
            print('%-18s %s' % (h, i))
" || echo "  (needs python3 on the host)"
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
    value=$(pool_for "$gluetun" "$ARG2" "$ISP_FILTER" "$POOL_SIZE")
    if [[ -z "$value" ]]; then
      if [[ -n "$ISP_FILTER" ]]; then
        echo "no wireguard servers for city '$ARG2' on isp '$ISP_FILTER' — check \`$0 servers $ARG2\`" >&2
      else
        echo "no wireguard servers found for city '$ARG2'" >&2
      fi
      exit 1
    fi
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
