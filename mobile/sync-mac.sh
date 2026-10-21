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
#                                 # (light and dark) saved to <dir> here
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

# dist/ is built here; .env.local (git-ignored) supplies the VITE_ values.
build_local() {
  if [ ! -f "$HERE/.env.local" ]; then
    "$HERE/scripts/env-from-ask.sh" "${ASK_URL:-https://ask.hbqnexus.win}"
  fi
  (cd "$HERE" && npm run build)
}

sync_up() {
  build_local
  ssh -o BatchMode=yes "$MAC" "mkdir -p ~/$REMOTE"
  # dist/ is synced; sources, env files and build outputs are not. Excluded
  # paths are also kept on the Mac (no --delete-excluded), e.g. node_modules.
  rsync -a --delete \
    --exclude node_modules/ --exclude src/ --exclude coverage/ \
    --exclude .env.e2e --exclude .env.local --exclude '.env.local.*' \
    --exclude 'ios/DerivedData/' --exclude 'ios/App/build/' \
    --exclude 'ios/App/App/public/' --exclude 'ios/App/CapApp-SPM/.build/' \
    --exclude '**/xcuserdata/' --exclude .DS_Store \
    "$HERE/" "$MAC:$REMOTE/"
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
# relaunch the app cold and screenshot it once it has settled.
sim() {
  local shots="${1:?usage: $0 sim <local-screenshot-dir>}" udid appearance
  mkdir -p "$shots"
  sync_up
  sim_build
  udid=$(sim_udid)
  echo "Simulator: $udid"
  remote "xcrun simctl install $udid $SIM_APP"
  for appearance in light dark; do
    remote "xcrun simctl ui $udid appearance $appearance \
      && xcrun simctl launch --terminate-running-process $udid $APP_ID >/dev/null \
      && sleep ${SETTLE:-4} \
      && xcrun simctl io $udid screenshot --type=png /tmp/ask-sim-$appearance.png >/dev/null 2>&1"
    scp -q "$MAC:/tmp/ask-sim-$appearance.png" "$shots/sign-in-$appearance.png"
    echo "Saved $shots/sign-in-$appearance.png"
  done
}

# launch-times [n]: cold-launch the installed simulator build n times and time
# each from `simctl launch` to the app's ASK_FIRST_RENDER mark (logged when the
# first real screen is ready; src/app/launchMark.ts). The mark carries the
# web view's Date.now(); the simulator shares the Mac's clock. --console-pty
# keeps the app's stdout line-buffered, so the line arrives promptly. (The
# Mac's login shell is zsh, so the remote script avoids word splitting.)
launch_times() {
  local n="${1:-3}" udid
  udid=$(sim_udid)
  echo "Simulator: $udid"
  remote "
    log=\$(mktemp -t ask-launch)
    trap 'rm -f \"\$log\"' EXIT
    now_ms() { perl -MTime::HiRes=time -e 'printf \"%d\n\", time * 1000'; }
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
      if [ -z \"\$mark\" ]; then echo \"launch \$i: no ASK_FIRST_RENDER mark within 15 s\"; continue; fi
      perf=\$(echo \"\$mark\" | cut -d ' ' -f 2); epoch=\$(echo \"\$mark\" | cut -d ' ' -f 3)
      echo \"launch \$i: \$((epoch - t0)) ms from simctl launch to first render (page clock \$perf ms)\"
    done"
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
  all) sync_up && build_install ;;
  *) echo "usage: $0 [all|sync|sim <dir>|launch-times [n]|devices|pull-ios]" >&2; exit 2 ;;
esac
