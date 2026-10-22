import UIKit

/// What the page tells the native shell about the chrome around it: its
/// background colour (the container behind the web view, seen behind the
/// keyboard and at launch) and whether the status bar must show light content
/// whatever the page colour (the image viewer is black).
///
/// The theme script (MainViewController.swift) posts
/// `{ background: "rgba(r, g, b, a)", statusBar: "light" | "auto" }`.
/// Compiled into the App and into AskShareTests, where it is unit tested.
struct PageChrome: Equatable {
    /// nil: keep the current colour (transparent or unparseable).
    let background: UIColor?
    /// The page forces light status-bar content.
    let lightStatusBar: Bool

    /// Reads a theme message; nil for a body that is not a dictionary.
    static func from(messageBody: Any) -> PageChrome? {
        guard let body = messageBody as? [String: Any] else { return nil }
        return PageChrome(
            background: (body["background"] as? String).flatMap { color(fromCSS: $0) },
            lightStatusBar: body["statusBar"] as? String == "light")
    }

    /// Parses "rgb(r, g, b)" / "rgba(r, g, b, a)" as the theme script reports
    /// it, opaque (the container is the page's backdrop). Transparent (alpha
    /// 0) and anything else is nil.
    static func color(fromCSS css: String) -> UIColor? {
        let css = css.trimmingCharacters(in: .whitespaces)
        guard css.hasPrefix("rgb") else { return nil }
        let parts = css.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
            .compactMap { Double($0) }
        guard parts.count >= 3 else { return nil }
        if parts.count >= 4, parts[3] == 0 { return nil }
        return UIColor(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: 1)
    }

    /// Whether a page colour is dark, so the status bar needs light content.
    static func isDark(_ color: UIColor) -> Bool {
        var white: CGFloat = 0
        color.getWhite(&white, alpha: nil)
        return white < 0.5
    }

    /// How far a keyboard covers the bottom of a view, both frames in the
    /// same coordinates: up to the view's bottom edge when the keyboard
    /// reaches it, 0 when it is off screen or floating (an iPad's undocked or
    /// split keyboard, which the page should not make room for).
    static func keyboardOverlap(keyboard: CGRect, in view: CGRect) -> CGFloat {
        guard !keyboard.isEmpty, keyboard.maxY >= view.maxY else { return 0 }
        return max(0, view.maxY - keyboard.minY)
    }

    /// Light content over a dark page or when the page asks for it, dark
    /// content otherwise.
    static func statusBarStyle(pageIsDark: Bool, lightStatusBar: Bool) -> UIStatusBarStyle {
        pageIsDark || lightStatusBar ? .lightContent : .darkContent
    }
}
