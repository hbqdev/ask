# Ask for iOS

A bundled React app (React 19, Vite 7, Tailwind 4) in a Capacitor 8 shell.
Vite builds `src/` into `dist/` and Capacitor ships `dist/` inside the app; it
talks to Ask's backend (`https://ask.hbqnexus.win` by default) over fetch with
a bearer token. It is not published: it's installed on Tin's devices with
Xcode, signed by the paid Apple Development team `P7G23CKH62`, so an install
lasts a year.

UI changes need an app rebuild; backend changes reach the app with no rebuild.

## Where things build

The app reuses Ask's own `lib/` modules, so `dist/` is built **on NightFuryX**
in this repo, and the MacBook (`tintran@nightfurym3max.local`,
`~/dev/ask-mobile`, Node 26, Xcode 27) only does the native part:

| Step | Where | Why |
| --- | --- | --- |
| `npm test`, `coverage`, `typecheck`, `npm run build` -> `dist/` | NightFuryX | they resolve `@/lib/` and `@ask/` to Ask's `../lib/`, whose imports need Ask's root `node_modules` |
| `npm install` (Capacitor packages), `npx cap sync ios`, `xcodebuild` | Mac | the plugins' Swift packages live in `node_modules/@capacitor/*`; the Capacitor CLI needs Node >= 22 (never run `cap` on NightFuryX) |

`sync-mac.sh` does the whole hand-off: it builds `dist/` here (rewriting
`.env.local` before every build and printing the target, e.g.
`Building for API: https://ask.hbqnexus.win`), copies the folder to the Mac without
`src/`, `node_modules/`, `coverage/` or any `.env*` file (the values are
already baked into `dist/`), then runs `npm install` and `cap sync ios` there.

### Prerequisites on NightFuryX

- Ask's root `node_modules` installed (the repo's own `bun install`).
- This folder's packages: `npx npm@10 install` (npm 9.2 hits an `edgesOut`
  install bug).
- `.env.local`: `scripts/env-from-ask.sh [api-url]` writes it (git-ignored)
  from Ask's root `.env`. `sync-mac.sh` runs it before every build, so an
  app build never reuses a server from an earlier one: the default is
  `https://ask.hbqnexus.win`, and `ASK_URL` picks another (e.g.
  `ASK_URL=<staging-url> ./sync-mac.sh sim <dir>`). Only a bare
  `npm run build` uses whatever `.env.local` already holds.

## Develop and test

Use npm in this folder (it has its own `package-lock.json`; Ask's root
typecheck, lint and tests exclude `mobile/`).

```bash
npm run dev          # Vite dev server
npm test             # Vitest (jsdom + Testing Library)
npm run coverage     # fails below functions 100 / lines 95 / branches 90 / statements 95
npm run typecheck
npm run build        # tsc -b && vite build -> dist/
```

### Path aliases

Set in both `vite.config.ts` and `tsconfig.json` (keep them in step):

- `@ask/` -> Ask's pure modules in the repo's `../lib/` (reused, not copied).
- `@/lib/` -> also `../lib/`. Ask's lib modules import each other as
  `@/lib/...`, so this prefix must reach Ask's lib here too; it is listed
  before `@/` because the first matching alias wins.
- `@/` -> this app's own `src/`.

So **never create `mobile/src/lib/`**: `@/lib/...` would still resolve to
Ask's `lib/`, and the folder would be silently unreachable.

## Build and install

The source of truth is this folder in the Ask repo. Run these on NightFuryX:

```bash
./sync-mac.sh            # build dist/, sync, then device build + install on the iPhone
./sync-mac.sh sync       # build dist/, sync, `cap sync ios` (e.g. to open it in Xcode)
./sync-mac.sh sim <dir>  # sync, simulator build, launch, light + dark screenshots into <dir>
./sync-mac.sh launch-times [n]  # n cold launches of the simulator build, timed
./sync-mac.sh pull-ios   # copy the Mac's ios/ back (commit Package.swift changes)
./sync-mac.sh devices    # list devices the Mac can see
DEVICE=<udid> ./sync-mac.sh   # install on another paired device
```

The simulator path is unsigned (`CODE_SIGNING_ALLOWED=NO`) and uses a booted
iPhone (preferring "iPhone 17"), else boots "iPhone 17"; `SIM_UDID` picks
another. `launch-times` times each launch from `simctl launch` to the
`ASK_FIRST_RENDER` line the app logs when its first screen is ready
(`src/app/launchMark.ts`; Capacitor forwards `console.log` in Debug builds).

`cap sync ios` regenerates `ios/App/CapApp-SPM/Package.swift` from the
installed plugins; after adding a plugin, `pull-ios` and commit it.

Code signing (device builds) needs the Mac's login keychain. Over SSH it is
locked, so the build step asks for the Mac password. Alternatively, after a
`./sync-mac.sh sync`, run `~/dev/ask-mobile/build-install.sh` in Terminal on
the Mac (it never builds `dist/`; that comes from the sync), or open
`ios/App/App.xcodeproj` in Xcode and press Run.

A new device must be paired with the Mac once (connect it by cable, trust the
Mac, and enable Developer Mode under Settings → Privacy & Security).

## Files

- `capacitor.config.ts`: app id `win.hbqnexus.ask`, `webDir: 'dist'`, iOS
  view settings, splash.
- `src/`: the app (`main.tsx` entry, `App.tsx`, `styles.css` theme).
- `scripts/env-from-ask.sh`: writes `.env.local` (prints variable names only).
- `sync-mac.sh` (runs here) and `build-install.sh` (runs on the Mac): see
  above.
- `ios/App/App/MainViewController.swift`: edge-to-edge container (the page
  pads itself with `env(safe-area-inset-*)`: `.app-root`, `.safe-bottom` and
  friends in `src/styles.css`), theme colour and status bar from the page
  (`PageChrome.swift`, light over the image viewer via
  `src/core/ui/status-bar.ts`), and a status-bar tap sent to the page as a
  `statusTap` event (`src/core/nav/scroll-to-top.ts`). Swipe-back is the
  app's own, in `src/core/nav/stack.tsx`; the web view's back/forward
  gestures stay off.
- `ios/App/App/Info.plist`: permission prompts; portrait-only on iPhone,
  arm64, no background modes.
- `ios/App/App/PrivacyInfo.xcprivacy` and `ios/App/AskShare/PrivacyInfo.xcprivacy`:
  the privacy manifests (UserDefaults reasons; the app's lists the data it
  collects). Each is a resource of its own target.
- `assets/icon.svg`, `assets/icon-dark.svg`, `assets/icon-tinted.svg`: sources
  for the app icon's default, dark and tinted appearances in
  `ios/App/App/Assets.xcassets/AppIcon.appiconset` (1024x1024). The default
  has a full-bleed background and no alpha; the dark and tinted ones are the
  mark on transparent (tinted in greys, which iOS tints).
- `assets/splash-mark.svg`: the launch mark (`SplashMark.imageset`, 96 pt at
  @2x and @3x), the in-app `OrbitMark` at the web `LaunchView`'s size. The
  launch storyboard centres it on the safe area over the `LaunchBackground`
  colour set: light `#fcfcfc` (`oklch(0.99 0 0)`), dark `#030309`
  (`oklch(0.1 0.022 289)`), the page's own background; the same pair is
  `MainViewController`'s first colour and `--splash` in `src/styles.css`, and
  `src/launch-colours.test.ts` checks they agree.

  Render on the Mac with `sips` (hex colours only; `sips` misreads `hsl()`):

  ```bash
  sips -s format png icon-dark.svg --out AppIcon-dark-1024.png
  sips -s format png splash-mark.svg --out splash-mark@3x.png
  cp splash-mark@3x.png splash-mark@2x.png && sips -z 192 192 splash-mark@2x.png
  sips -g hasAlpha *.png   # yes, except the default icon
  ```
