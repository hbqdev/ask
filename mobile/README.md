# Ask for iOS

A native iOS shell around the live site (`https://ask.hbqnexus.win`). It is not
published: it's installed on Tin's devices with Xcode, signed by the paid
Apple Development team `P7G23CKH62`, so an install lasts a year.

The app loads the live site, so **web deploys reach the app with no rebuild**.
Rebuild only when something in this folder changes.

## What the shell adds over Safari

- Login that persists: `CapacitorCookies` stores the cookies Supabase writes
  from page scripts in the native cookie store. Safari caps script-written
  cookies at 7 days, the likely cause of the web logouts.
- Full screen with no browser bars. The web view is pinned to the safe area
  (`MainViewController.swift`) and the notch and home-indicator strips take
  the page's background colour, light or dark.
- Swipe from the left edge to go back. Links to other sites open in Safari.
- "Sign in with Google" works in-app: the app presents a mobile Safari user
  agent, because Google blocks OAuth in embedded web views.
- Microphone (dictation), camera and photos (attachments), location (weather)
  and background audio (read-aloud) permissions.

## Build and install

The source of truth is this folder in the Ask repo. The MacBook
(`tintran@nightfurym3max.local`, `~/dev/ask-mobile`) only builds.

```bash
./sync-mac.sh            # copy to the Mac, then build + install on the iPhone
./sync-mac.sh sync       # copy + `cap sync` only (e.g. to open it in Xcode)
./sync-mac.sh devices    # list devices the Mac can see
DEVICE=<udid> ./sync-mac.sh   # install on another paired device
```

Code signing needs the Mac's login keychain. Over SSH it is locked, so the
build step asks for the Mac password. Alternatively, in Terminal on the Mac run
`~/dev/ask-mobile/build-install.sh`, or open `ios/App/App.xcodeproj` in Xcode
and press Run.

A new device must be paired with the Mac once (connect it by cable, trust the
Mac, and enable Developer Mode under Settings → Privacy & Security).

## Files

- `capacitor.config.ts`: app id `win.hbqnexus.ask`, site URL, allowed hosts,
  cookies, splash.
- `ios/App/App/MainViewController.swift`: safe-area container, theme colour,
  swipe-back.
- `ios/App/App/Info.plist`: permission prompts, background audio.
- `assets/icon.svg`, `assets/splash.svg`: sources for the icon and launch
  images in `ios/App/App/Assets.xcassets` (rendered on the Mac with `sips`;
  use hex colours, `sips` misreads `hsl()`).
- `www/`: the offline page shown when the site can't be reached.
