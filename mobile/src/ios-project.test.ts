import { readFileSync } from 'node:fs'
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
