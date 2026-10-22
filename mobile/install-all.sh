#!/usr/bin/env bash
# Build Ask once (signed, Release) and install it on every listed device.
# Runs ON THE MAC in the logged-in desktop session (where the login keychain
# is unlocked), e.g. launched over SSH with:
#   osascript -e 'tell application "Terminal" to do script "~/dev/ask-mobile/install-all.sh"'
# Progress and results go to /tmp/ask-install.log (ends with ALL_DONE).
cd "$(dirname "$0")"
LOG=/tmp/ask-install.log
DEVICES=${DEVICES:-"00008130-00120DAA3420001C 00008110-000E05EC142A801E 00008103-001978420CD0801E"}
: > "$LOG"
for d in $DEVICES; do
  echo "== $d" | tee -a "$LOG"
  if DEVICE=$d ./build-install.sh >>"$LOG" 2>&1; then echo "OK $d" | tee -a "$LOG"; else echo "FAILED $d" | tee -a "$LOG"; fi
done
echo ALL_DONE | tee -a "$LOG"
