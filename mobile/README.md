# Ask for iOS

A bundled React app (React 19, Vite 7, Tailwind 4) in a Capacitor 8 shell.
Vite builds `src/` into `dist/` and Capacitor ships `dist/` inside the app; it
talks to Ask's backend (`https://ask.hbqnexus.win` by default) over fetch with
a bearer token. It is not published: it's installed on Tin's devices with
Xcode, signed by the paid Apple Development team `P7G23CKH62`, so an install
lasts a year.

UI changes need an app rebuild; backend changes reach the app with no rebuild.

## Develop and test

Use npm in this folder (it has its own `package-lock.json`; Ask's root
typecheck, lint and tests exclude `mobile/`). npm 9.2 hits an `edgesOut`
install bug, so on the dev box use `npx npm@10 install`.

```bash
scripts/env-from-ask.sh [api-url]  # writes .env.local (git-ignored) from Ask's .env
npm run dev          # Vite dev server
npm test             # Vitest (jsdom + Testing Library)
npm run coverage     # fails below functions 100 / lines 95 / branches 90 / statements 95
npm run typecheck
npm run build        # tsc -b && vite build -> dist/
npm run cap:sync     # build, then `cap sync ios`
```

`@/` resolves to `src/`; `@ask/` resolves to Ask's pure modules in `../lib/`
(set in both `vite.config.ts` and `tsconfig.json`).

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

- `capacitor.config.ts`: app id `win.hbqnexus.ask`, `webDir: 'dist'`, iOS
  view settings, splash.
- `src/`: the app (`main.tsx` entry, `App.tsx`, `styles.css` theme).
- `scripts/env-from-ask.sh`: writes `.env.local` (prints variable names only).
- `ios/App/App/MainViewController.swift`: safe-area container, theme colour,
  swipe-back.
- `ios/App/App/Info.plist`: permission prompts, background audio.
- `assets/icon.svg`, `assets/splash.svg`: sources for the icon and launch
  images in `ios/App/App/Assets.xcassets` (rendered on the Mac with `sips`;
  use hex colours, `sips` misreads `hsl()`).
