#!/usr/bin/env bash
# Build the Ask iOS app on the MacBook and install it on a paired device.
#
# The source of truth is this folder in the Ask repo (on NightFuryX). The Mac
# only builds: this script copies the folder there, runs `cap sync`, builds
# with Xcode's command-line tools, and installs on the device.
#
#   ./sync-mac.sh                 # sync + build + install on the iPhone
#   ./sync-mac.sh sync            # sync only (e.g. before opening Xcode)
#   ./sync-mac.sh pull-ios        # copy the Mac's ios/ project back here
#   DEVICE=<udid> ./sync-mac.sh   # install on another device (see `devices`)
#   ./sync-mac.sh devices         # list devices the Mac can see
#
# Signing: Apple Development, team P7G23CKH62 (Tin Tran, paid account, so
# the install lasts a year). The device must be paired with the Mac (it is
# when it shows as "available (paired)" under `devices`).
set -euo pipefail

MAC=${MAC:-tintran@nightfurym3max.local}
REMOTE=${REMOTE:-dev/ask-mobile}
TEAM=${TEAM:-P7G23CKH62}
DEVICE=${DEVICE:-00008130-00120DAA3420001C} # Tin's iPhone 15 Pro Max
HERE="$(cd "$(dirname "$0")" && pwd)"

remote() { ssh -o BatchMode=yes "$MAC" "export PATH=/opt/homebrew/bin:\$PATH; cd ~/$REMOTE && $1"; }

sync_up() {
  ssh -o BatchMode=yes "$MAC" "mkdir -p ~/$REMOTE"
  rsync -a --delete \
    --exclude node_modules/ --exclude 'ios/App/build/' --exclude 'ios/DerivedData/' \
    --exclude 'ios/App/App/public/' --exclude 'ios/App/CapApp-SPM/.build/' \
    --exclude '**/xcuserdata/' --exclude '.DS_Store' \
    "$HERE/" "$MAC:$REMOTE/"
  remote "npm install --no-audit --no-fund --loglevel=error && npx cap sync ios"
}

build_install() {
  # Signing needs the Mac's login keychain, which is locked over SSH. -t gives
  # build-install.sh a terminal so it can ask for the Mac password.
  ssh -t "$MAC" "DEVICE=$DEVICE TEAM=$TEAM ~/$REMOTE/build-install.sh"
}

case "${1:-all}" in
  sync) sync_up ;;
  devices) remote "xcrun devicectl list devices" ;;
  pull-ios)
    rsync -a --exclude 'App/build/' --exclude 'DerivedData/' --exclude 'App/App/public/' \
      --exclude 'App/CapApp-SPM/.build/' --exclude '**/xcuserdata/' --exclude '.DS_Store' \
      "$MAC:$REMOTE/ios/" "$HERE/ios/" ;;
  all) sync_up && build_install ;;
  *) echo "usage: $0 [all|sync|devices|pull-ios]" >&2; exit 2 ;;
esac
