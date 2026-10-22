import Capacitor
import UIKit
import WebKit

/// Root of the Ask shell (created in SceneDelegate).
///
/// Capacitor makes its web view the whole screen, so the page would draw under
/// the notch and the home indicator, and Ask's layout has no safe-area
/// padding. Capacitor 8 marks `loadView()` final, so instead of re-parenting
/// the web view this container embeds Capacitor's controller as a child pinned
/// to the safe area. The container's colour follows the page background
/// (light or dark theme), so the strips above and below look like the page.
final class MainViewController: UIViewController {
    /// The page background per appearance until the page reports its own:
    /// light oklch(0.99 0 0) = #fcfcfc, dark oklch(0.1 0.022 289) = #030309,
    /// the same as the launch screen (LaunchBackground, Splash).
    private static let launchBackground = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x03 / 255, green: 0x03 / 255, blue: 0x09 / 255, alpha: 1)
            : UIColor(red: 0xFC / 255, green: 0xFC / 255, blue: 0xFC / 255, alpha: 1)
    }

    let bridgeController = AskBridgeViewController()
    private var pageIsDark = true

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.launchBackground
        pageIsDark = traitCollection.userInterfaceStyle == .dark
        bridgeController.onPageBackground = { [weak self] color in self?.apply(color) }

        addChild(bridgeController)
        let child = bridgeController.view!
        child.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(child)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            child.topAnchor.constraint(equalTo: guide.topAnchor),
            child.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            child.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
        ])
        bridgeController.didMove(toParent: self)
    }

    private func apply(_ color: UIColor) {
        view.backgroundColor = color
        var white: CGFloat = 0
        color.getWhite(&white, alpha: nil)
        let dark = white < 0.5
        if dark != pageIsDark {
            pageIsDark = dark
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    // The container, not Capacitor's child, decides the status bar style.
    override var childForStatusBarStyle: UIViewController? { nil }
    override var preferredStatusBarStyle: UIStatusBarStyle {
        pageIsDark ? .lightContent : .darkContent
    }
}

/// Capacitor's controller with the Ask-specific web view setup.
final class AskBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private static let themeMessage = "askTheme"
    var onPageBackground: ((UIColor) -> Void)?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Share to Ask: what the share extension left in the App Group inbox
        // (src/core/shared-inbox.ts).
        bridge?.registerPluginInstance(SharedInboxPlugin())
        guard let web = webView else { return }
        // No WKWebView back/forward swipes: the app's own navigation stack
        // (src/core/nav/stack.tsx) owns the edge swipe-back, and a native
        // history swipe on top of it would animate twice and desync the stack.
        web.allowsBackForwardNavigationGestures = false

        // Report the page background whenever the theme can have changed:
        // on load, when the <html> class flips (ThemeProvider sets `light` or
        // `dark`), and when the system appearance changes.
        let controller = web.configuration.userContentController
        controller.add(self, name: Self.themeMessage)
        controller.addUserScript(WKUserScript(
            source: Self.themeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.evaluateJavaScript(Self.themeScript, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.themeMessage, let css = message.body as? String,
              let color = Self.parse(css) else { return }
        onPageBackground?(color)
    }

    /// Parses "rgb(r, g, b)" / "rgba(r, g, b, a)" from getComputedStyle.
    private static func parse(_ css: String) -> UIColor? {
        let parts = css.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted)
            .compactMap { Double($0) }
        guard parts.count >= 3 else { return nil }
        if parts.count >= 4, parts[3] == 0 { return nil } // transparent: keep current
        return UIColor(red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: 1)
    }

    private static let themeScript = """
    (function () {
      if (window.__askThemeHook) { window.__askThemeHook(); return; }
      // getComputedStyle returns Ask's oklch() colours as lab()/oklch(), not
      // rgb(), so paint the colour on a 1x1 canvas and read back sRGB pixels.
      function rgba(css) {
        var cv = document.createElement('canvas'); cv.width = cv.height = 1;
        var x = cv.getContext('2d');
        x.clearRect(0, 0, 1, 1); x.fillStyle = 'rgba(0,0,0,0)'; x.fillStyle = css;
        x.fillRect(0, 0, 1, 1);
        var d = x.getImageData(0, 0, 1, 1).data;
        return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + (d[3] / 255) + ')';
      }
      function post() {
        var b = document.body ? rgba(getComputedStyle(document.body).backgroundColor) : '';
        var h = rgba(getComputedStyle(document.documentElement).backgroundColor);
        var c = (b && b.slice(-3) !== ' 0)') ? b : h;
        try { window.webkit.messageHandlers.\(themeMessage).postMessage(c); } catch (e) {}
      }
      window.__askThemeHook = post;
      new MutationObserver(post).observe(document.documentElement,
        { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', post);
      }
      post();
    })();
    """
}
