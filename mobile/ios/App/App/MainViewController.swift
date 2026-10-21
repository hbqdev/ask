import Capacitor
import UIKit
import WebKit

/// Root view controller for the Ask shell.
///
/// Capacitor normally makes the web view the whole screen, so the page would
/// draw under the notch and the home indicator. Ask's layout has no safe-area
/// padding, so instead the web view is pinned to the safe area inside a
/// container, and the container's colour follows the page background (light
/// or dark theme) so the strips above and below look like part of the page.
class MainViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private static let themeMessage = "askTheme"
    private var pageIsDark = true

    override func loadView() {
        super.loadView()
        guard let web = view else { return }
        let container = UIView(frame: web.frame)
        container.backgroundColor = UIColor(red: 0x0C / 255, green: 0x0A / 255, blue: 0x14 / 255, alpha: 1)
        web.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(web)
        let guide = container.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: guide.topAnchor),
            web.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
        ])
        view = container
    }

    override func capacitorDidLoad() {
        guard let web = webView else { return }
        // Swipe from the left edge to go back, like Safari and native apps.
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .clear

        // Report the page background whenever the theme can have changed:
        // on load, when the <html> class flips (next-themes), and when the
        // system appearance changes.
        let controller = web.configuration.userContentController
        controller.add(self, name: Self.themeMessage)
        controller.addUserScript(WKUserScript(
            source: Self.themeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.evaluateJavaScript(Self.themeScript, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.themeMessage, let css = message.body as? String,
              let color = Self.parse(css) else { return }
        view.backgroundColor = color
        var white: CGFloat = 0
        color.getWhite(&white, alpha: nil)
        let dark = white < 0.5
        if dark != pageIsDark {
            pageIsDark = dark
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        pageIsDark ? .lightContent : .darkContent
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
      function post() {
        var b = document.body ? getComputedStyle(document.body).backgroundColor : '';
        var h = getComputedStyle(document.documentElement).backgroundColor;
        var c = (b && b !== 'rgba(0, 0, 0, 0)') ? b : h;
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
