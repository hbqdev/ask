import UIKit
import XCTest

// PageChrome.swift is compiled into this bundle (no host app), so these run
// as plain logic tests on the simulator.
final class PageChromeTests: XCTestCase {
    /// A colour's sRGB components, rounded to whole 0–255 steps, and its alpha.
    private func components(_ color: UIColor?) -> [Int]? {
        guard let color else { return nil }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
        return [r, g, b, a].map { Int(($0 * 255).rounded()) }
    }

    // MARK: - Colours

    func testParsesRgbAndRgba() {
        XCTAssertEqual(components(PageChrome.color(fromCSS: "rgb(252, 252, 252)")), [252, 252, 252, 255])
        XCTAssertEqual(components(PageChrome.color(fromCSS: "rgba(3, 3, 9, 1)")), [3, 3, 9, 255])
        // The container is the page's backdrop, so a translucent page colour
        // is painted opaque.
        XCTAssertEqual(components(PageChrome.color(fromCSS: "rgba(3, 3, 9, 0.5)")), [3, 3, 9, 255])
    }

    func testATransparentBackgroundKeepsTheCurrentColour() {
        XCTAssertNil(PageChrome.color(fromCSS: "rgba(0, 0, 0, 0)"))
        XCTAssertEqual(
            PageChrome.from(messageBody: ["background": "rgba(0, 0, 0, 0)", "statusBar": "auto"]),
            PageChrome(background: nil, lightStatusBar: false))
    }

    func testAnUnparseableColourIsNil() {
        // getComputedStyle reports Ask's colours as oklch(); the theme script
        // converts them, and anything that is not rgb()/rgba() is ignored.
        XCTAssertNil(PageChrome.color(fromCSS: "oklch(0.1 0.022 289)"))
        XCTAssertNil(PageChrome.color(fromCSS: ""))
        XCTAssertNil(PageChrome.color(fromCSS: "rgb(1, 2)"))
    }

    // MARK: - Messages

    func testReadsTheBackgroundAndAnAutoStatusBar() {
        let chrome = PageChrome.from(messageBody: ["background": "rgba(252, 252, 252, 1)", "statusBar": "auto"])
        XCTAssertEqual(components(chrome?.background), [252, 252, 252, 255])
        XCTAssertEqual(chrome?.lightStatusBar, false)
    }

    func testStatusBarLightForcesLightContent() {
        let chrome = PageChrome.from(messageBody: ["background": "rgba(252, 252, 252, 1)", "statusBar": "light"])
        XCTAssertEqual(chrome?.lightStatusBar, true)
        // Light content even over the light page (the image viewer is black).
        XCTAssertEqual(PageChrome.statusBarStyle(pageIsDark: false, lightStatusBar: true), .lightContent)
        XCTAssertEqual(PageChrome.statusBarStyle(pageIsDark: true, lightStatusBar: true), .lightContent)
    }

    func testTheStatusBarFollowsThePageOtherwise() {
        XCTAssertEqual(PageChrome.statusBarStyle(pageIsDark: true, lightStatusBar: false), .lightContent)
        XCTAssertEqual(PageChrome.statusBarStyle(pageIsDark: false, lightStatusBar: false), .darkContent)
    }

    func testABodyThatIsNotADictionaryIsIgnored() {
        // The page's old message was the colour string alone.
        XCTAssertNil(PageChrome.from(messageBody: "rgba(3, 3, 9, 1)"))
        XCTAssertNil(PageChrome.from(messageBody: 42))
    }

    func testAnUnparseableColourLeavesTheBackgroundNilButKeepsTheStatusBar() {
        XCTAssertEqual(
            PageChrome.from(messageBody: ["background": "oklch(0.1 0.022 289)", "statusBar": "light"]),
            PageChrome(background: nil, lightStatusBar: true))
        // A missing or non-string background reads the same way.
        XCTAssertEqual(
            PageChrome.from(messageBody: ["statusBar": "light"]),
            PageChrome(background: nil, lightStatusBar: true))
        XCTAssertEqual(
            PageChrome.from(messageBody: ["background": 7, "statusBar": 1]),
            PageChrome(background: nil, lightStatusBar: false))
    }

    // MARK: - Keyboard

    private let screen = CGRect(x: 0, y: 0, width: 402, height: 874)

    func testADockedKeyboardOverlapsByItsHeight() {
        let keyboard = CGRect(x: 0, y: 546, width: 402, height: 328)
        XCTAssertEqual(PageChrome.keyboardOverlap(keyboard: keyboard, in: screen), 328)
    }

    func testAKeyboardOffScreenOrEmptyOverlapsNothing() {
        // keyboardWillHide's end frame sits just below the screen.
        XCTAssertEqual(PageChrome.keyboardOverlap(keyboard: CGRect(x: 0, y: 874, width: 402, height: 328), in: screen), 0)
        XCTAssertEqual(PageChrome.keyboardOverlap(keyboard: .zero, in: screen), 0)
    }

    func testAFloatingKeyboardLeavesThePageAlone() {
        // An iPad's floating or split keyboard does not reach the bottom edge.
        let floating = CGRect(x: 40, y: 400, width: 320, height: 260)
        XCTAssertEqual(PageChrome.keyboardOverlap(keyboard: floating, in: screen), 0)
    }

    func testAKeyboardPastTheBottomEdgeCountsOnlyTheOverlap() {
        // A view that ends above the screen's bottom (a shorter window).
        let view = CGRect(x: 0, y: 0, width: 402, height: 800)
        let keyboard = CGRect(x: 0, y: 546, width: 402, height: 328)
        XCTAssertEqual(PageChrome.keyboardOverlap(keyboard: keyboard, in: view), 254)
    }

    func testWithNoKeyboardTheWebViewReachesTheBottomEdge() {
        XCTAssertEqual(PageChrome.bottomPinConstant(keyboard: nil, in: screen), 0)
    }

    func testTheWebViewEndsAtTheKeyboardsTop() {
        let keyboard = CGRect(x: 0, y: 546, width: 402, height: 328)
        XCTAssertEqual(PageChrome.bottomPinConstant(keyboard: keyboard, in: screen), -328)
    }

    func testAResizeWithTheKeyboardUpIsRecomputed() {
        // A Stage Manager window 700 pt tall whose bottom meets the same
        // keyboard: in the window's coordinates the keyboard starts at 372.
        let window = CGRect(x: 0, y: 0, width: 402, height: 700)
        XCTAssertEqual(
            PageChrome.bottomPinConstant(keyboard: CGRect(x: 0, y: 372, width: 402, height: 328), in: window), -328)
        // The window shrinks to end 128 pt above the keyboard: nothing to clear.
        let shorter = CGRect(x: 0, y: 0, width: 402, height: 500)
        XCTAssertEqual(
            PageChrome.bottomPinConstant(keyboard: CGRect(x: 0, y: 572, width: 402, height: 328), in: shorter), 0)
    }

    // MARK: - Light or dark

    func testDarkAndLightPageColours() {
        XCTAssertTrue(PageChrome.isDark(UIColor(red: 3 / 255, green: 3 / 255, blue: 9 / 255, alpha: 1)))
        XCTAssertFalse(PageChrome.isDark(UIColor(red: 252 / 255, green: 252 / 255, blue: 252 / 255, alpha: 1)))
        XCTAssertTrue(PageChrome.isDark(.black))
        XCTAssertFalse(PageChrome.isDark(.white))
    }
}
