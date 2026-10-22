#!/usr/bin/env bash
# Build the Ask iOS app: the web bundle here, the native app on the MacBook.
#
# The source of truth is this folder in the Ask repo (on NightFuryX). The app
# imports Ask's lib/ (the `@/lib/` and `@ask/` aliases) and its build needs
# Ask's root node_modules, so `dist/` is built HERE. The Mac only installs the
# Capacitor packages (for their native Swift code), runs `cap sync ios`
# (copies dist/ into the iOS project, needs Node >= 22) and builds with Xcode.
#
#   ./sync-mac.sh                 # sync + device build + install on the iPhone
#   ./sync-mac.sh sync            # build dist/, copy to the Mac, `cap sync ios`
#   ./sync-mac.sh sim <dir>       # sync + simulator build, launch, screenshots
#                                 # (light and dark) saved to <dir> here; the
#                                 # bundle is an E2E build (see build_local)
#   ./sync-mac.sh launch-times [n]  # n cold launches (default 3) of the
#                                 # simulator build, timed to first render
#   ./sync-mac.sh pull-ios        # copy the Mac's ios/ project back here
#   DEVICE=<udid> ./sync-mac.sh   # install on another device (see `devices`)
#   ./sync-mac.sh devices         # list devices the Mac can see
#
# Signing (device builds only): Apple Development, team P7G23CKH62 (Tin Tran,
# paid account, so the install lasts a year). The device must be paired with
# the Mac (it is when it shows as "available (paired)" under `devices`).
# Simulator builds are unsigned and need no password.
set -euo pipefail

MAC=${MAC:-tintran@nightfurym3max.local}
REMOTE=${REMOTE:-dev/ask-mobile}
TEAM=${TEAM:-P7G23CKH62}
DEVICE=${DEVICE:-00008130-00120DAA3420001C} # Tin's iPhone 15 Pro Max
SIM_UDID=${SIM_UDID:-}                      # default: a booted iPhone
APP_ID=win.hbqnexus.ask
SIM_APP=ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app
HERE="$(cd "$(dirname "$0")" && pwd)"

remote() { ssh -o BatchMode=yes "$MAC" "export PATH=/opt/homebrew/bin:\$PATH; cd ~/$REMOTE && $1"; }

# Every step must stop the script when it fails (a failed build must never
# ship a stale dist/), so functions are never called on the left of && or ||,
# where bash ignores `set -e`.

# dist/ is built here. .env.local (git-ignored) supplies the VITE_ values and
# is rewritten before EVERY build, so a build never reuses a server left over
# from an earlier one: production by default, ASK_URL to point a build
# elsewhere (e.g. staging). The API origin is printed first (it is not secret).
#
# build_local e2e makes the simulator E2E bundle (VITE_E2E_AUTOSEND=true): an
# ask:// link sends at once, a question seeded in Preferences (e2e-ask) is
# asked at launch and a seeded screen (e2e-screen) is opened. Every other build sets it false explicitly, so a value in
# the caller's environment can never leak into a device build, where a link
# from any app must only fill the box (a turn can write a lasting memory).
build_local() {
  local api="${ASK_URL:-https://ask.hbqnexus.win}" autosend=false
  if [ "${1:-}" = e2e ]; then autosend=true; fi
  echo "Building for API: $api (E2E auto-send: $autosend)"
  "$HERE/scripts/env-from-ask.sh" "$api"
  (cd "$HERE" && VITE_E2E_AUTOSEND="$autosend" npm run build)
}

# sync_up [e2e]: build (an E2E build when asked) and sync to the Mac.
sync_up() {
  build_local "${1:-}"
  ssh -o BatchMode=yes "$MAC" "mkdir -p ~/$REMOTE"
  # dist/ is synced; sources, env files and build outputs are not. Excluded
  # paths are also kept on the Mac (no --delete-excluded), e.g. node_modules.
  rsync -a --delete \
    --exclude node_modules/ --exclude src/ --exclude coverage/ --exclude '.env*' \
    --exclude 'ios/DerivedData/' --exclude 'ios/App/build/' \
    --exclude 'ios/App/App/public/' --exclude 'ios/App/CapApp-SPM/.build/' \
    --exclude '**/xcuserdata/' --exclude .DS_Store \
    "$HERE/" "$MAC:$REMOTE/"
  # Being excluded, these survive --delete; drop any left by older syncs. (find,
  # not a glob: the Mac's login shell is zsh, which errors on a glob with no
  # match.)
  remote "find . -maxdepth 1 \\( -name src -o -name coverage -o -name '.env*' \\) -exec rm -rf {} +"
  remote "npm install --no-audit --no-fund --loglevel=error && npx cap sync ios"
}

build_install() {
  # Signing needs the Mac's login keychain, which is locked over SSH. -t gives
  # build-install.sh a terminal so it can ask for the Mac password.
  ssh -t "$MAC" "DEVICE=$DEVICE TEAM=$TEAM ~/$REMOTE/build-install.sh"
}

# The UDID of the simulator to use: SIM_UDID, else a booted "iPhone 17", else
# any booted iPhone, else "iPhone 17" booted now.
sim_udid() {
  if [ -n "$SIM_UDID" ]; then echo "$SIM_UDID"; return; fi
  remote '
    booted=$(xcrun simctl list devices booted | grep -E "^ +iPhone")
    udid=$( { echo "$booted" | grep -E "^ +iPhone 17 \(" ; echo "$booted"; } \
      | grep -oE "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}" | head -n 1)
    if [ -z "$udid" ]; then
      udid=$(xcrun simctl list devices available | grep -E "^ +iPhone 17 \(" \
        | grep -oE "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}" | head -n 1)
      [ -n "$udid" ] || { echo "no iPhone 17 simulator" >&2; exit 1; }
      xcrun simctl boot "$udid" >&2
      xcrun simctl bootstatus "$udid" >/dev/null
    fi
    echo "$udid"'
}

sim_build() {
  remote "xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO -quiet build"
}

# sim <dir>: build for the simulator, install, then for each appearance
# relaunch the app cold and screenshot it once it has settled. The
# simulator's own appearance is put back afterwards, even on failure.
sim() {
  local shots="${1:?usage: $0 sim <local-screenshot-dir>}" appearance shot
  mkdir -p "$shots"
  sync_up e2e
  sim_build
  SIM_DEVICE=$(sim_udid)
  echo "Simulator: $SIM_DEVICE"
  SIM_ORIGINAL_APPEARANCE=$(remote "xcrun simctl ui $SIM_DEVICE appearance")
  trap restore_appearance EXIT
  remote "xcrun simctl install $SIM_DEVICE $SIM_APP"
  for appearance in light dark; do
    shot=/tmp/ask-sim-$appearance.png
    remote "xcrun simctl ui $SIM_DEVICE appearance $appearance \
      && xcrun simctl launch --terminate-running-process $SIM_DEVICE $APP_ID >/dev/null \
      && sleep ${SETTLE:-4} \
      && xcrun simctl io $SIM_DEVICE screenshot --type=png $shot >/dev/null"
    scp -q "$MAC:$shot" "$shots/sign-in-$appearance.png"
    remote "rm -f $shot"
    echo "Saved $shots/sign-in-$appearance.png"
  done
}

# EXIT trap for sim: the appearance it found (light or dark) goes back.
restore_appearance() {
  case "${SIM_ORIGINAL_APPEARANCE:-}" in
    light|dark)
      remote "xcrun simctl ui $SIM_DEVICE appearance $SIM_ORIGINAL_APPEARANCE" ||
        echo "could not restore the simulator's $SIM_ORIGINAL_APPEARANCE appearance" >&2 ;;
  esac
}

# launch-times [n]: cold-launch the installed simulator build n times and time
# each from `simctl launch` to the app's ASK_FIRST_RENDER mark (logged when the
# first real screen is ready; src/app/launchMark.ts). The mark carries the
# web view's Date.now(); the simulator shares the Mac's clock. --console-pty
# keeps the app's stdout line-buffered, so the line arrives promptly. (The
# Mac's login shell is zsh, so the remote script avoids word splitting.)
launch_times() {
  local n="${1:-3}" udid
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ]; then
    echo "launch-times: n must be a positive whole number, got '$n'" >&2
    exit 2
  fi
  udid=$(sim_udid)
  echo "Simulator: $udid"
  remote "
    log=\$(mktemp -t ask-launch)
    trap 'rm -f \"\$log\"' EXIT
    now_ms() { perl -MTime::HiRes=time -e 'printf \"%d\n\", time * 1000'; }
    missed=0
    for i in \$(seq 1 $n); do
      xcrun simctl terminate $udid $APP_ID >/dev/null 2>&1 || true
      sleep 3
      : > \"\$log\"
      t0=\$(now_ms)
      xcrun simctl launch --console-pty $udid $APP_ID > \"\$log\" 2>&1 &
      pid=\$!
      for _ in \$(seq 1 150); do grep -q ASK_FIRST_RENDER \"\$log\" && break; sleep 0.1; done
      kill \$pid 2>/dev/null || true; wait \$pid 2>/dev/null || true
      mark=\$(grep -m 1 -oE 'ASK_FIRST_RENDER [0-9.]+ [0-9]+' \"\$log\" || true)
      if [ -z \"\$mark\" ]; then
        echo \"launch \$i: no ASK_FIRST_RENDER mark within 15 s\" >&2
        missed=\$((missed + 1)); continue
      fi
      perf=\$(echo \"\$mark\" | cut -d ' ' -f 2); epoch=\$(echo \"\$mark\" | cut -d ' ' -f 3)
      echo \"launch \$i: \$((epoch - t0)) ms from simctl launch to first render (page clock \$perf ms)\"
    done
    if [ \$missed -gt 0 ]; then echo \"\$missed of $n launches logged no mark\" >&2; exit 1; fi"
}

case "${1:-all}" in
  sync) sync_up ;;
  sim) shift; sim "$@" ;;
  launch-times) shift; launch_times "$@" ;;
  devices) remote "xcrun devicectl list devices" ;;
  pull-ios)
    rsync -a --exclude 'App/build/' --exclude 'DerivedData/' --exclude 'App/App/public/' \
      --exclude 'App/CapApp-SPM/.build/' --exclude '**/xcuserdata/' --exclude '.DS_Store' \
      "$MAC:$REMOTE/ios/" "$HERE/ios/" ;;
  all) sync_up; build_install ;;
  *) echo "usage: $0 [all|sync|sim <dir>|launch-times [n]|devices|pull-ios]" >&2; exit 2 ;;
esac
