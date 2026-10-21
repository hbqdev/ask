#!/usr/bin/env bash
# Build the Ask iOS app and install it on a paired device. Runs ON THE MAC
# (sync-mac.sh copies it to ~/dev/ask-mobile).
#
# dist/ is built on NightFuryX (it needs Ask's lib/ and root node_modules) and
# arrives with the sync, so this script never builds the web bundle: it only
# installs the Capacitor packages, runs `cap sync ios` and builds the app.
#
#   ~/dev/ask-mobile/build-install.sh              # Tin's iPhone 15 Pro Max
#   DEVICE=<udid> ~/dev/ask-mobile/build-install.sh
#   xcrun devicectl list devices                    # find a device's UDID
#
# Code signing needs the login keychain unlocked. In a Terminal window on the
# Mac it already is. Over SSH it is locked (codesign fails with
# errSecInternalComponent), so the script asks for the Mac password once
# to unlock it for this session.
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")"

TEAM=${TEAM:-P7G23CKH62}
DEVICE=${DEVICE:-00008130-00120DAA3420001C}
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ ! -f dist/index.html ]; then
  echo "No dist/: run ./sync-mac.sh on NightFuryX first (it builds dist/ there)." >&2
  exit 1
fi

if ! security show-keychain-info "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Unlocking the login keychain for code signing (Mac password):"
  security unlock-keychain "$KEYCHAIN"
fi

npm install --no-audit --no-fund --loglevel=error
npx cap sync ios

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath ios/DerivedData \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates \
  -quiet build

xcrun devicectl device install app --device "$DEVICE" \
  ios/DerivedData/Build/Products/Release-iphoneos/App.app
echo "Installed Ask on $DEVICE."
