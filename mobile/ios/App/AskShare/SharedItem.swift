import Foundation
import UniformTypeIdentifiers

// Share to Ask, the parts with no UI: what a share becomes (SharedItem) and
// the one-item inbox it waits in (SharedInbox). Compiled into the AskShare
// extension (which writes the inbox), the App (whose SharedInboxPlugin takes
// it) and AskShareTests, so the three always agree on the format.

/// What Ask takes from a share: its text and/or web link, as one question
/// draft. Images and files are not taken.
struct SharedItem: Equatable {
    /// The longest draft, as for an ask:// link (src/core/deep-link.ts).
    static let maxCharacters = 2000

    let text: String

    /// The shared text pieces (each trimmed, blanks and repeats dropped) on
    /// their own lines, then the link on a new line unless the text already
    /// holds it; at most 2000 characters, cut from the text so the link stays
    /// whole. nil when nothing is left (no text, and no link but a file's).
    init?(texts: [String], url: URL?) {
        var pieces: [String] = []
        for text in texts {
            let piece = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !piece.isEmpty, !pieces.contains(piece) { pieces.append(piece) }
        }
        var body = pieces.joined(separator: "\n")
        if let link = url.flatMap({ $0.isFileURL ? nil : $0.absoluteString }),
           !body.contains(link) {
            if body.isEmpty {
                body = link
            } else {
                let room = max(0, Self.maxCharacters - link.count - 1)
                body = String(body.prefix(room)) + "\n" + link
            }
        }
        body = String(body.trimmingCharacters(in: .whitespacesAndNewlines)
            .prefix(Self.maxCharacters))
        guard !body.isEmpty else { return nil }
        text = body
    }

    /// Reads the share's attachments (each a link or plain text; anything
    /// else, such as an image or a file, adds nothing) and calls completion on
    /// the main queue with the item, or nil when there is nothing to take.
    static func load(from providers: [NSItemProvider],
                     completion: @escaping (SharedItem?) -> Void) {
        let found = Found(count: providers.count)
        let group = DispatchGroup()
        for (index, provider) in providers.enumerated() {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
                    found.set(index, .url(Self.url(from: value)))
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                group.enter()
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
                    found.set(index, .text(Self.text(from: value)))
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) { completion(found.item()) }
    }

    private static func url(from value: NSSecureCoding?) -> URL? {
        if let url = value as? URL { return url }
        var string = value as? String
        if let data = value as? Data {
            // An NSURL put in a provider arrives as its archived form; some
            // apps send the link's bytes instead.
            if let url = try? NSURL.object(withItemProviderData: data,
                                           typeIdentifier: UTType.url.identifier) {
                return url as URL
            }
            string = String(data: data, encoding: .utf8)
        }
        return string.flatMap { URL(string: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    private static func text(from value: NSSecureCoding?) -> String? {
        if let string = value as? String { return string }
        if let attributed = value as? NSAttributedString { return attributed.string }
        if let data = value as? Data { return String(data: data, encoding: .utf8) }
        return nil
    }

    /// The attachments' contents in their order, filled in from the item
    /// providers' (background) completion handlers.
    private final class Found: @unchecked Sendable {
        enum Piece { case text(String?), url(URL?) }
        private var pieces: [Piece?]
        private let lock = NSLock()

        init(count: Int) { pieces = Array(repeating: nil, count: count) }

        func set(_ index: Int, _ piece: Piece) {
            lock.lock(); defer { lock.unlock() }
            pieces[index] = piece
        }

        func item() -> SharedItem? {
            lock.lock(); defer { lock.unlock() }
            var texts: [String] = []
            var urls: [URL] = []
            for case let piece? in pieces {
                switch piece {
                case .text(let text?): texts.append(text)
                case .url(let url?): urls.append(url)
                default: break
                }
            }
            return SharedItem(texts: texts, url: urls.first { !$0.isFileURL })
        }
    }
}

/// The inbox in the App Group's shared defaults: one item, a newer share
/// replacing one the app has not taken yet. Stored as
/// ["text": String, "createdAt": ms since 1970, "id": UUID string] under
/// `sharedInbox`.
struct SharedInbox {
    static let appGroup = "group.win.hbqnexus.ask"
    static let key = "sharedInbox"
    /// take() reads and clears in one step, even if called twice at once.
    private static let lock = NSLock()

    let defaults: UserDefaults

    /// The inbox the extension and the app share (nil if the group's
    /// defaults cannot be opened).
    static func appGroupInbox() -> SharedInbox? {
        UserDefaults(suiteName: appGroup).map(SharedInbox.init(defaults:))
    }

    /// Each put gets its own id, so two shares in the same millisecond still
    /// differ (see remove(ifStill:)).
    func put(_ item: SharedItem, at date: Date = Date()) {
        let createdAt = (date.timeIntervalSince1970 * 1000).rounded()
        defaults.set(["text": item.text, "createdAt": createdAt, "id": UUID().uuidString],
                     forKey: Self.key)
    }

    /// The waiting item, removed from the inbox; nil when there is none (a
    /// malformed entry is removed too).
    func take() -> (text: String, createdAt: Double)? {
        Self.lock.lock(); defer { Self.lock.unlock() }
        let stored = defaults.dictionary(forKey: Self.key)
        remove(ifStill: stored)
        guard let text = stored?["text"] as? String,
              let createdAt = stored?["createdAt"] as? Double else { return nil }
        return (text, createdAt)
    }

    /// Removes the inbox's entry only while it is still `entry`. The extension
    /// writes from another process, so a share put after take() read the
    /// inbox is newer: it stays for the next take instead of being lost.
    /// (UserDefaults has no compare-and-swap; this narrows the window to the
    /// moment between this read and the remove.)
    func remove(ifStill entry: [String: Any]?) {
        guard let entry,
              let current = defaults.dictionary(forKey: Self.key),
              (current as NSDictionary).isEqual(entry as NSDictionary) else { return }
        defaults.removeObject(forKey: Self.key)
    }
}
