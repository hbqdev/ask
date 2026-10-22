import Capacitor
import UIKit
import WebKit

/// Root of the Ask shell (created in SceneDelegate).
///
/// Capacitor 8 marks `loadView()` final, so instead of re-parenting the web
/// view this container embeds Capacitor's controller as a child, pinned to
/// the screen edges: the page runs edge to edge and clears the status bar,
/// the rounded corners and the home indicator itself with
/// env(safe-area-inset-*) (src/styles.css), so its own colour fills the
/// strips. The container's colour follows the page background (it shows
/// behind the keyboard and at launch), and so does the status bar, unless
/// the page asks for light content (PageChrome).
final class MainViewController: UIViewController, UIScrollViewDelegate {
    /// The page background per appearance until the page reports its own:
    /// light oklch(0.99 0 0) = #fcfcfc, dark oklch(0.1 0.022 289) = #030309,
    /// the same as the launch screen (LaunchBackground, behind the SplashMark).
    private static let launchBackground = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x03 / 255, green: 0x03 / 255, blue: 0x09 / 255, alpha: 1)
            : UIColor(red: 0xFC / 255, green: 0xFC / 255, blue: 0xFC / 255, alpha: 1)
    }

    let bridgeController = AskBridgeViewController()
    private var pageIsDark = true
    private var lightStatusBar = false
    /// The web view's bottom: the screen's bottom edge, or the keyboard's top.
    private var bottomPin: NSLayoutConstraint!

    /// Status-bar taps. iOS scrolls a `scrollsToTop` scroll view on a tap on
    /// the status bar; the page's scrollers are overflow elements it cannot
    /// see, and the web view's own scroll view is turned off. So this one,
    /// clear and behind the web view, is the only candidate: it is never
    /// at the top (offset 1 of 2) and its delegate turns the tap into a
    /// `statusTap` window event (src/core/nav/scroll-to-top.ts) instead of
    /// scrolling. Full width: iOS offers the tap only to scroll views under
    /// its x position (a 1-pt-wide one answers taps at the far left only).
    private let statusTapSentinel = UIScrollView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.launchBackground
        pageIsDark = traitCollection.userInterfaceStyle == .dark
        bridgeController.onPageChrome = { [weak self] chrome in self?.apply(chrome) }

        let sentinel = statusTapSentinel
        sentinel.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 1)
        sentinel.autoresizingMask = [.flexibleWidth]
        sentinel.backgroundColor = .clear
        sentinel.alpha = 1
        sentinel.showsVerticalScrollIndicator = false
        sentinel.showsHorizontalScrollIndicator = false
        sentinel.contentSize = CGSize(width: 1, height: 2)
        sentinel.contentOffset = CGPoint(x: 0, y: 1)
        sentinel.scrollsToTop = true
        sentinel.accessibilityElementsHidden = true
        sentinel.delegate = self
        view.addSubview(sentinel)

        addChild(bridgeController)
        let child = bridgeController.view!
        child.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(child)
        bottomPin = child.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            child.topAnchor.constraint(equalTo: view.topAnchor),
            bottomPin,
            child.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        bridgeController.didMove(toParent: self)

        let center = NotificationCenter.default
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
            center.addObserver(self, selector: #selector(keyboardWillMove(_:)), name: name, object: nil)
        }
    }

    /// The keyboard. The web view ends at its top, so the composer sits just
    /// above it and the page sees no bottom inset meanwhile (it is clear of
    /// the home indicator), so nothing is lifted twice. The Keyboard plugin's
    /// native resize sets the web view's frame too, but the next layout pass
    /// puts the frame back to these constraints (the composer ended up under
    /// the keyboard), and keyboardLayoutGuide did not follow the keyboard on
    /// the iOS 27 simulator; so the bottom pin follows the keyboard's frame,
    /// moving with it. (The plugin's frame then agrees with it.)
    @objc private func keyboardWillMove(_ note: Notification) {
        guard let info = note.userInfo,
              let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else { return }
        let keyboard = note.name == UIResponder.keyboardWillHideNotification
            ? .zero
            : view.convert(end, from: view.window?.screen.coordinateSpace ?? UIScreen.main.coordinateSpace)
        let overlap = PageChrome.keyboardOverlap(keyboard: keyboard, in: view.bounds)
        guard bottomPin.constant != -overlap else { return }
        bottomPin.constant = -overlap
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt) ?? 7
        UIView.animate(withDuration: duration, delay: 0,
                       options: UIView.AnimationOptions(rawValue: curve << 16)) {
            self.view.layoutIfNeeded()
        }
    }

    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        bridgeController.bridge?.triggerWindowJSEvent(eventName: "statusTap")
        return false
    }

    private func apply(_ chrome: PageChrome) {
        let style = preferredStatusBarStyle
        if let background = chrome.background {
            view.backgroundColor = background
            pageIsDark = PageChrome.isDark(background)
        }
        lightStatusBar = chrome.lightStatusBar
        if preferredStatusBarStyle != style {
            // The image viewer fades in and out over 200 ms; so does this.
            UIView.animate(withDuration: 0.2) { self.setNeedsStatusBarAppearanceUpdate() }
        }
    }

    // The container, not Capacitor's child, decides the status bar style.
    override var childForStatusBarStyle: UIViewController? { nil }
    override var preferredStatusBarStyle: UIStatusBarStyle {
        PageChrome.statusBarStyle(pageIsDark: pageIsDark, lightStatusBar: lightStatusBar)
    }
}

/// Capacitor's controller with the Ask-specific web view setup.
final class AskBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private static let themeMessage = "askTheme"
    var onPageChrome: ((PageChrome) -> Void)?

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
        // A status-bar tap goes to MainViewController's sentinel, which
        // tells the page; the web view's own scroll never moves (the page
        // scrolls in its own elements).
        web.scrollView.scrollsToTop = false

        // Report the page background and the status-bar override whenever
        // they can have changed: on load, when the <html> class flips
        // (ThemeProvider sets `light` or `dark`), when <html
        // data-status-bar> does (src/core/ui/status-bar.ts), and when the
        // system appearance changes.
        let controller = web.configuration.userContentController
        controller.add(self, name: Self.themeMessage)
        controller.addUserScript(WKUserScript(
            source: Self.themeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.evaluateJavaScript(Self.themeScript, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.themeMessage,
              let chrome = PageChrome.from(messageBody: message.body) else { return }
        onPageChrome?(chrome)
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
        var s = document.documentElement.dataset.statusBar === 'light' ? 'light' : 'auto';
        try {
          window.webkit.messageHandlers.\(themeMessage).postMessage({ background: c, statusBar: s });
        } catch (e) {}
      }
      window.__askThemeHook = post;
      new MutationObserver(post).observe(document.documentElement,
        { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-status-bar'] });
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', post);
      }
      post();
    })();
    """
}
