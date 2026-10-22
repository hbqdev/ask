import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const read = (path: string) =>
  readFileSync(resolve(__dirname, '../ios/App', path), 'utf8')

// The bundle needs iOS 16.4: the initial chunk uses a lookbehind regex
// (Safari 16.4) and Array findLast / at. An older target would install and
// then fail to start.
describe('the iOS project', () => {
  it('targets iOS 16.4 in every build configuration', () => {
    const targets = [
      ...read('App.xcodeproj/project.pbxproj').matchAll(
        /IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/g
      )
    ].map(m => m[1])
    expect(targets.length).toBeGreaterThan(0)
    expect(new Set(targets)).toEqual(new Set(['16.4']))
  })

  it('declares the matching iOS 16 platform for its Swift packages', () => {
    // `cap sync` writes .iOS(.v<major>) from the project's target, and
    // SwiftPM has no minor-version enum, so 16.4 is .v16 here.
    expect(read('CapApp-SPM/Package.swift')).toContain(
      'platforms: [.iOS(.v16)]'
    )
  })
})

describe('the iOS app’s permission prompts', () => {
  // iOS shows these strings when Ask first asks for the camera, the photo
  // library (attachments) and the microphone (dictation); a missing one ends
  // the app at that moment instead.
  const plist = read('App/Info.plist')
  const usage = (key: string) =>
    plist.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`)
    )?.[1]

  it('explains the camera, the photo library and the microphone in plain English', () => {
    expect(usage('NSCameraUsageDescription')).toBe(
      'Ask uses the camera so you can take a photo and ask about it.'
    )
    expect(usage('NSPhotoLibraryUsageDescription')).toBe(
      'Ask uses your photo library so you can attach pictures to a question.'
    )
    expect(usage('NSMicrophoneUsageDescription')).toBe(
      'Ask uses the microphone so you can dictate your question.'
    )
  })
})

// Share to Ask: the AskShare extension writes what another app shares into
// the App Group's defaults, where the app's SharedInbox plugin takes it.
describe('the Share to Ask extension', () => {
  const pbxproj = read('App.xcodeproj/project.pbxproj')
  const APP_GROUP = 'group.win.hbqnexus.ask'

  /** The build settings of every configuration that sets `key = value`. */
  const configsWith = (key: string, value: string) =>
    [...pbxproj.matchAll(/buildSettings = \{([^}]*)\};/g)]
      .map(m => m[1])
      .filter(s => s.includes(`${key} = ${value};`))

  it('is an app extension target, embedded in the app', () => {
    expect(pbxproj).toMatch(
      /name = AskShare;[^}]*productType = "com\.apple\.product-type\.app-extension";/
    )
    // Embedded in the app's PlugIns folder (dstSubfolderSpec 13).
    expect(pbxproj).toMatch(
      /isa = PBXCopyFilesBuildPhase;[^}]*dstSubfolderSpec = 13;[^}]*AskShare\.appex in Embed/
    )
    expect(pbxproj).toMatch(/isa = PBXTargetDependency;[^}]*\/\* AskShare \*\//)
  })

  it('has its own bundle id under the app’s, extension-safe APIs only', () => {
    const share = configsWith(
      'PRODUCT_BUNDLE_IDENTIFIER',
      'win.hbqnexus.ask.share'
    )
    expect(share).toHaveLength(2) // Debug and Release
    for (const s of share) {
      expect(s).toContain('APPLICATION_EXTENSION_API_ONLY = YES;')
      expect(s).toContain('INFOPLIST_FILE = AskShare/Info.plist;')
      expect(s).toContain(
        'CODE_SIGN_ENTITLEMENTS = AskShare/AskShare.entitlements;'
      )
      expect(s).toContain('SKIP_INSTALL = YES;')
    }
  })

  it('shares the App Group with the app', () => {
    const app = configsWith('PRODUCT_BUNDLE_IDENTIFIER', 'win.hbqnexus.ask')
    expect(app).toHaveLength(2)
    for (const s of app) {
      expect(s).toContain('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;')
    }
    for (const file of [
      'App/App.entitlements',
      'AskShare/AskShare.entitlements'
    ]) {
      expect(read(file)).toMatch(
        new RegExp(
          `<key>com\\.apple\\.security\\.application-groups</key>\\s*<array>\\s*<string>${APP_GROUP}</string>\\s*</array>`
        )
      )
    }
    expect(read('AskShare/SharedItem.swift')).toContain(`"${APP_GROUP}"`)
  })

  it('appears for shared text and web links, and nothing else', () => {
    const plist = read('AskShare/Info.plist')
    expect(plist).toMatch(
      /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.share-services<\/string>/
    )
    expect(plist).toMatch(
      /<key>NSExtensionPrincipalClass<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.ShareViewController<\/string>/
    )
    const rule = plist.match(
      /<key>NSExtensionActivationRule<\/key>\s*<dict>([\s\S]*?)<\/dict>/
    )?.[1]
    expect(rule).toBeDefined()
    expect([...rule!.matchAll(/<key>([^<]+)<\/key>/g)].map(m => m[1])).toEqual([
      'NSExtensionActivationSupportsText',
      'NSExtensionActivationSupportsWebURLWithMaxCount'
    ])
  })

  it('has a unit test target for the shared-item logic, in a shared scheme', () => {
    expect(pbxproj).toMatch(
      /name = AskShareTests;[^}]*productType = "com\.apple\.product-type\.bundle\.unit-test";/
    )
    expect(
      read('App.xcodeproj/xcshareddata/xcschemes/AskShareTests.xcscheme')
    ).toMatch(/<TestableReference[\s\S]*BlueprintName = "AskShareTests"/)
  })

  it('registers the SharedInbox plugin on the bridge', () => {
    expect(read('App/MainViewController.swift')).toContain(
      'bridge?.registerPluginInstance(SharedInboxPlugin())'
    )
    expect(read('App/SharedInboxPlugin.swift')).toContain(
      'jsName = "SharedInbox"'
    )
  })
})

/** A plist's XML as a JS value (dict, array, string, true/false, numbers). */
function parsePlist(xml: string): unknown {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const value = (el: Element): unknown => {
    const kids = [...el.children]
    switch (el.tagName) {
      case 'dict': {
        const out: Record<string, unknown> = {}
        for (let i = 0; i < kids.length; i += 2) {
          out[kids[i].textContent ?? ''] = value(kids[i + 1])
        }
        return out
      }
      case 'array':
        return kids.map(value)
      case 'true':
        return true
      case 'false':
        return false
      case 'integer':
      case 'real':
        return Number(el.textContent)
      default:
        return el.textContent
    }
  }
  return value(doc.documentElement.children[0])
}

describe('the iOS app’s capabilities', () => {
  const plist = parsePlist(read('App/Info.plist')) as Record<string, unknown>

  it('has no background modes', () => {
    // Read-aloud stops when the app leaves the screen; App Review rejects a
    // background mode the app does not use.
    expect(plist).not.toHaveProperty('UIBackgroundModes')
  })

  it('runs on arm64 only', () => {
    expect(plist.UIRequiredDeviceCapabilities).toEqual(['arm64'])
  })

  it('is portrait-only on iPhone and keeps all four orientations on iPad', () => {
    expect(plist.UISupportedInterfaceOrientations).toEqual([
      'UIInterfaceOrientationPortrait'
    ])
    expect(plist['UISupportedInterfaceOrientations~ipad']).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight'
    ])
  })

  it('asks for no location', () => {
    expect(plist).not.toHaveProperty('NSLocationWhenInUseUsageDescription')
  })

  it('explains saving to Photos', () => {
    expect(plist.NSPhotoLibraryAddUsageDescription).toBe(
      'Ask saves an image to your photo library when you choose Save to Photos.'
    )
  })
})

// Apple requires a privacy manifest in every bundle that uses a
// required-reason API (UserDefaults here: Capacitor Preferences in the app,
// the App Group's defaults in both), and the app's lists the data it collects.
describe('the privacy manifests', () => {
  type Manifest = {
    NSPrivacyTracking: boolean
    NSPrivacyTrackingDomains: string[]
    NSPrivacyAccessedAPITypes: {
      NSPrivacyAccessedAPIType: string
      NSPrivacyAccessedAPITypeReasons: string[]
    }[]
    NSPrivacyCollectedDataTypes: {
      NSPrivacyCollectedDataType: string
      NSPrivacyCollectedDataTypeLinked: boolean
      NSPrivacyCollectedDataTypeTracking: boolean
      NSPrivacyCollectedDataTypePurposes: string[]
    }[]
  }
  const manifest = (path: string) => parsePlist(read(path)) as Manifest

  const userDefaults = (reasons: string[]) => [
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
      NSPrivacyAccessedAPITypeReasons: reasons
    }
  ]

  it('the app’s privacy manifest declares UserDefaults for the app and the App Group', () => {
    const m = manifest('App/PrivacyInfo.xcprivacy')
    expect(m.NSPrivacyTracking).toBe(false)
    expect(m.NSPrivacyTrackingDomains).toEqual([])
    expect(m.NSPrivacyAccessedAPITypes).toEqual(
      userDefaults(['CA92.1', '1C8F.1'])
    )
    expect(m.NSPrivacyCollectedDataTypes).toEqual(
      [
        'EmailAddress',
        'UserID',
        'PhotosorVideos',
        'OtherUserContent',
        'SearchHistory'
      ].map(type => ({
        NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
        NSPrivacyCollectedDataTypeLinked: true,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: [
          'NSPrivacyCollectedDataTypePurposeAppFunctionality'
        ]
      }))
    )
  })

  it('the extension’s privacy manifest declares UserDefaults for the App Group', () => {
    const m = manifest('AskShare/PrivacyInfo.xcprivacy')
    expect(m.NSPrivacyTracking).toBe(false)
    expect(m.NSPrivacyTrackingDomains).toEqual([])
    expect(m.NSPrivacyAccessedAPITypes).toEqual(userDefaults(['1C8F.1']))
    expect(m.NSPrivacyCollectedDataTypes).toEqual([])
  })

  it('each manifest is a resource of its own target', () => {
    const pbxproj = read('App.xcodeproj/project.pbxproj')
    /** The build-file ids in one Resources phase that are privacy manifests. */
    const manifestsIn = (phase: string) => {
      const files = pbxproj.match(
        new RegExp(
          `${phase} /\\* Resources \\*/ = \\{[^}]*files = \\(([^)]*)\\)`
        )
      )?.[1]
      expect(files).toBeDefined()
      return [
        ...files!.matchAll(
          /([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy in Resources \*\//g
        )
      ].map(m => m[1])
    }
    const app = manifestsIn('504EC3021FED79650016851F')
    const share = manifestsIn('25B87410552A0EC2E9FAC073')
    expect(app).toHaveLength(1)
    expect(share).toHaveLength(1)
    expect(manifestsIn('407CDBEEA6C043423D4E2999')).toEqual([])
    // Each build file points at a different file reference, in its target's
    // own folder.
    const ref = (buildFile: string) =>
      pbxproj.match(
        new RegExp(
          `${buildFile} /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ([0-9A-F]{24})`
        )
      )?.[1]
    const appRef = ref(app[0])
    const shareRef = ref(share[0])
    expect(appRef).toBeDefined()
    expect(shareRef).toBeDefined()
    expect(appRef).not.toBe(shareRef)
    const group = (name: string) =>
      pbxproj.match(
        new RegExp(
          `/\\* ${name} \\*/ = \\{\\s*isa = PBXGroup;\\s*children = \\(([^)]*)\\);\\s*path = ${name};`
        )
      )?.[1]
    expect(group('App')).toContain(`${appRef} /* PrivacyInfo.xcprivacy */`)
    expect(group('AskShare')).toContain(
      `${shareRef} /* PrivacyInfo.xcprivacy */`
    )
  })
})

describe('the app icon', () => {
  it('the icon has dark and tinted 1024 appearances', () => {
    const { images } = JSON.parse(
      read('App/Assets.xcassets/AppIcon.appiconset/Contents.json')
    ) as {
      images: {
        filename: string
        idiom: string
        platform: string
        size: string
        appearances?: { appearance: string; value: string }[]
      }[]
    }
    expect(images).toHaveLength(3)
    for (const image of images) {
      expect(image).toMatchObject({
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024'
      })
    }
    expect(images.map(i => i.appearances)).toEqual([
      undefined,
      [{ appearance: 'luminosity', value: 'dark' }],
      [{ appearance: 'luminosity', value: 'tinted' }]
    ])
    expect(images.map(i => i.filename)).toEqual([
      'AppIcon-512@2x.png',
      'AppIcon-dark-1024.png',
      'AppIcon-tinted-1024.png'
    ])
    for (const { filename } of images) {
      expect(
        existsSync(
          resolve(
            __dirname,
            '../ios/App/App/Assets.xcassets/AppIcon.appiconset',
            filename
          )
        )
      ).toBe(true)
    }
  })
})

// Edge to edge: the web view fills the screen and the page clears the safe
// area itself (styles.css .app-root and friends), the status bar follows the
// page (PageChrome) and a status-bar tap reaches the page as `statusTap`.
describe('the native page chrome', () => {
  const swift = read('App/MainViewController.swift')
  const pbxproj = read('App.xcodeproj/project.pbxproj')

  it('pins the web view to the screen edges, not the safe area', () => {
    for (const edge of ['top', 'bottom', 'leading', 'trailing']) {
      expect(swift).toMatch(
        new RegExp(
          `child\\.${edge}Anchor\\.constraint\\(equalTo: view\\.${edge}Anchor\\)`
        )
      )
    }
    expect(swift).not.toContain('safeAreaLayoutGuide')
  })

  it('ends the web view at the keyboard', () => {
    // The Keyboard plugin's native resize sets the web view's frame, which the
    // next layout pass puts back to its constraints (the composer ended up
    // under the keyboard), and keyboardLayoutGuide did not follow the
    // keyboard on iOS 27. So the bottom pin's constant follows the keyboard's
    // frame (PageChrome.keyboardOverlap), with the keyboard's own animation.
    expect(swift).toContain('UIResponder.keyboardWillChangeFrameNotification')
    expect(swift).toContain('UIResponder.keyboardWillHideNotification')
    expect(swift).toContain(
      'let overlap = PageChrome.keyboardOverlap(keyboard: keyboard, in: view.bounds)'
    )
    expect(swift).toContain('bottomPin.constant = -overlap')
    expect(swift).not.toContain('view.keyboardLayoutGuide')
  })

  it('turns a status-bar tap into a statusTap window event', () => {
    // The web view's own scroll view never takes the tap, so the hidden
    // sentinel is the only candidate.
    expect(swift).toMatch(/web\.scrollView\.scrollsToTop = false/)
    expect(swift).toMatch(/func scrollViewShouldScrollToTop\(/)
    expect(swift).toContain('triggerWindowJSEvent(eventName: "statusTap")')
    // iOS offers the tap only to scroll views under its x position, so the
    // sentinel spans the width (1 pt tall) and follows it.
    expect(swift).toMatch(
      /sentinel\.frame = CGRect\(x: 0, y: 0, width: view\.bounds\.width, height: 1\)/
    )
    expect(swift).toContain('sentinel.autoresizingMask = [.flexibleWidth]')
  })

  it('reports the status-bar override with the page colour', () => {
    expect(swift).toMatch(/attributeFilter: \[[^\]]*'data-status-bar'[^\]]*\]/)
    expect(swift).toContain('document.documentElement.dataset.statusBar')
    expect(swift).toContain('PageChrome.from(messageBody: message.body)')
  })

  /** The file names compiled by one Sources build phase. */
  const sourcesOf = (phase: string) => {
    const files = pbxproj.match(
      new RegExp(`${phase} /\\* Sources \\*/ = \\{[^}]*files = \\(([^)]*)\\)`)
    )?.[1]
    expect(files).toBeDefined()
    return [...files!.matchAll(/\/\* (\S+) in Sources \*\//g)].map(m => m[1])
  }

  it('compiles PageChrome into the app and its tests', () => {
    expect(sourcesOf('504EC3001FED79650016851F')).toContain('PageChrome.swift')
    const tests = sourcesOf('4E1B5284F86CB73DE0DCD2BC')
    expect(tests).toContain('PageChrome.swift')
    expect(tests).toContain('PageChromeTests.swift')
    // Not in the share extension.
    expect(sourcesOf('3EA9C033AB93B5BD084EDB3A')).not.toContain(
      'PageChrome.swift'
    )
    expect(
      existsSync(resolve(__dirname, '../ios/App/App/PageChrome.swift'))
    ).toBe(true)
  })
})
