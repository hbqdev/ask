import UIKit

/// "Ask" in the share sheet: takes the shared text and/or web link, leaves it
/// in the App Group inbox (SharedInbox) for the app's composer, and says so.
/// The app only fills its box with it; nothing is ever sent from here.
///
/// Every way out (Open Ask, Done) completes the extension request, and the
/// sheet cannot be swiped away, so the host app is never left waiting.
final class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let openButton = UIButton(configuration: .filled())
    private let doneButton = UIButton(configuration: .gray())

    override func viewDidLoad() {
        super.viewDidLoad()
        isModalInPresentation = true
        view.backgroundColor = .systemBackground
        layout()
        show(title: "Sending to Ask…", message: nil, canOpen: false, busy: true)

        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        SharedItem.load(from: providers) { [weak self] item in
            self?.received(item)
        }
    }

    private func received(_ item: SharedItem?) {
        guard let item else {
            show(title: "Ask can't take images from Share yet",
                 message: "Share text or a link instead.", canOpen: false, busy: false)
            return
        }
        guard let inbox = SharedInbox.appGroupInbox() else {
            show(title: "Couldn't send to Ask",
                 message: "Copy the text and paste it into Ask.", canOpen: false, busy: false)
            return
        }
        inbox.put(item)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        show(title: "Sent to Ask", message: "Open Ask to continue.", canOpen: true, busy: false)
    }

    // MARK: - Actions

    @objc private func openAsk() {
        settle()
        // The text waits in the inbox; this link only brings Ask forward (a
        // blank q fills nothing), so the composer gets the text exactly once.
        let url = URL(string: "ask://ask?q=")!
        guard let context = extensionContext else { return }
        context.open(url) { [weak self] opened in
            DispatchQueue.main.async {
                guard let self else { return }
                if !opened { self.openThroughResponderChain(url) }
                self.finish()
            }
        }
    }

    @objc private func done() {
        settle()
        finish()
    }

    /// One tap is enough: the request is completed once.
    private func settle() {
        openButton.isEnabled = false
        doneButton.isEnabled = false
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    /// Share extensions may not open URLs through their context (that call
    /// reports failure), so ask the UIApplication up the responder chain,
    /// through the runtime: its open(_:options:completionHandler:) is marked
    /// unavailable to extensions at compile time. If none is found the text
    /// still waits in the inbox for the next time Ask opens.
    @discardableResult
    private func openThroughResponderChain(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                typealias Open = @convention(c) (
                    AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?
                ) -> Void
                let open = unsafeBitCast(current.method(for: selector), to: Open.self)
                open(current, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }

    // MARK: - Layout

    private func show(title: String, message: String?, canOpen: Bool, busy: Bool) {
        titleLabel.text = title
        messageLabel.text = message
        messageLabel.isHidden = message == nil
        openButton.isHidden = !canOpen
        doneButton.isHidden = busy
        if busy { spinner.startAnimating() } else { spinner.stopAnimating() }
        // VoiceOver reads the new state from its title.
        UIAccessibility.post(notification: .screenChanged, argument: titleLabel)
    }

    private func layout() {
        titleLabel.font = .preferredFont(forTextStyle: .title3)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.accessibilityTraits = .header
        messageLabel.font = .preferredFont(forTextStyle: .body)
        messageLabel.textColor = .secondaryLabel
        messageLabel.adjustsFontForContentSizeCategory = true
        for label in [titleLabel, messageLabel] {
            label.numberOfLines = 0
            label.textAlignment = .center
        }
        spinner.hidesWhenStopped = true

        openButton.configuration?.title = "Open Ask"
        openButton.configuration?.cornerStyle = .large
        openButton.addTarget(self, action: #selector(openAsk), for: .touchUpInside)
        doneButton.configuration?.title = "Done"
        doneButton.configuration?.cornerStyle = .large
        doneButton.addTarget(self, action: #selector(done), for: .touchUpInside)
        for button in [openButton, doneButton] {
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
        }

        let stack = UIStackView(arrangedSubviews: [
            spinner, titleLabel, messageLabel, openButton, doneButton,
        ])
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(24, after: messageLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let margins = view.layoutMarginsGuide
        // Full width on a phone, a 420 pt column on an iPad.
        let fill = stack.widthAnchor.constraint(equalTo: margins.widthAnchor, constant: -16)
        fill.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.centerXAnchor.constraint(equalTo: margins.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            stack.widthAnchor.constraint(lessThanOrEqualTo: margins.widthAnchor),
            fill,
        ])
    }
}
