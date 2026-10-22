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
