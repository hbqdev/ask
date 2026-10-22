import UniformTypeIdentifiers
import XCTest

// SharedItem.swift is compiled into this bundle (no host app), so these run
// as plain logic tests on the simulator.
final class SharedItemTests: XCTestCase {
    private let link = URL(string: "https://example.com/article?id=1")!

    // MARK: - Joining text and a link

    func testUrlAndTextJoinOnANewLine() {
        let item = SharedItem(texts: ["Look at this"], url: link)
        XCTAssertEqual(item?.text, "Look at this\nhttps://example.com/article?id=1")
    }

    func testTextThatAlreadyHoldsTheLinkIsNotRepeated() {
        let item = SharedItem(texts: ["Read https://example.com/article?id=1 today"], url: link)
        XCTAssertEqual(item?.text, "Read https://example.com/article?id=1 today")
    }

    func testALinkAloneOrTextAlone() {
        XCTAssertEqual(SharedItem(texts: [], url: link)?.text, link.absoluteString)
        XCTAssertEqual(SharedItem(texts: ["  just words \n"], url: nil)?.text, "just words")
    }

    func testRepeatedTextPiecesAppearOnce() {
        let item = SharedItem(texts: ["Title", " Title ", "Body"], url: nil)
        XCTAssertEqual(item?.text, "Title\nBody")
    }

    // MARK: - Length

    func testTruncatesTo2000Characters() {
        let item = SharedItem(texts: [String(repeating: "a", count: 3000)], url: nil)
        XCTAssertEqual(item?.text.count, 2000)
        XCTAssertEqual(SharedItem.maxCharacters, 2000)
    }

    func testTruncationKeepsTheLinkWhole() {
        let item = SharedItem(texts: [String(repeating: "a", count: 3000)], url: link)
        XCTAssertEqual(item?.text.count, 2000)
        XCTAssertTrue(item?.text.hasSuffix("\n" + link.absoluteString) ?? false)
    }

    // MARK: - Nothing Ask can take

    func testEmptyIsNil() {
        XCTAssertNil(SharedItem(texts: [], url: nil))
        XCTAssertNil(SharedItem(texts: ["   ", "\n"], url: nil))
    }

    func testAFileIsNotALink() {
        XCTAssertNil(SharedItem(texts: [], url: URL(fileURLWithPath: "/tmp/photo.png")))
    }

    // MARK: - Reading the share's attachments

    private func load(_ providers: [NSItemProvider]) -> SharedItem? {
        let done = expectation(description: "loaded")
        var result: SharedItem?
        SharedItem.load(from: providers) { item in
            XCTAssertTrue(Thread.isMainThread)
            result = item
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        return result
    }

    func testImageOnlyIsNil() {
        let png = NSItemProvider(item: Data([0x89, 0x50, 0x4E, 0x47]) as NSData,
                                 typeIdentifier: UTType.png.identifier)
        XCTAssertNil(load([png]))
    }

    func testAFileAttachmentOnlyIsNil() {
        let file = NSItemProvider(item: URL(fileURLWithPath: "/tmp/report.pdf") as NSURL,
                                  typeIdentifier: UTType.fileURL.identifier)
        XCTAssertNil(load([file]))
    }

    func testTextAndLinkAttachmentsJoin() {
        let text = NSItemProvider(object: "Look at this" as NSString)
        let url = NSItemProvider(object: link as NSURL)
        XCTAssertEqual(load([text, url])?.text, "Look at this\n" + link.absoluteString)
    }

    func testAnImageBesideALinkKeepsTheLink() {
        let png = NSItemProvider(item: Data([0x89, 0x50]) as NSData,
                                 typeIdentifier: UTType.png.identifier)
        let url = NSItemProvider(object: link as NSURL)
        XCTAssertEqual(load([png, url])?.text, link.absoluteString)
    }

    // MARK: - The App Group inbox

    private func inbox() -> SharedInbox {
        let name = "ask-share-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return SharedInbox(defaults: defaults)
    }

    func testTheInboxIsTheAppGroupsSharedInboxKey() {
        XCTAssertEqual(SharedInbox.appGroup, "group.win.hbqnexus.ask")
        XCTAssertEqual(SharedInbox.key, "sharedInbox")
    }

    func testAPutItemIsTakenOnceWithItsTime() throws {
        let box = inbox()
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        box.put(try XCTUnwrap(SharedItem(texts: ["hello"], url: nil)), at: when)

        let taken = box.take()
        XCTAssertEqual(taken?.text, "hello")
        XCTAssertEqual(taken?.createdAt, 1_800_000_000_000)
        XCTAssertNil(box.take())
    }

    func testANewerShareReplacesAnUntakenOne() throws {
        let box = inbox()
        box.put(try XCTUnwrap(SharedItem(texts: ["first"], url: nil)), at: Date())
        box.put(try XCTUnwrap(SharedItem(texts: ["second"], url: nil)), at: Date())
        XCTAssertEqual(box.take()?.text, "second")
    }

    func testEachPutHasItsOwnId() throws {
        let box = inbox()
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        let item = try XCTUnwrap(SharedItem(texts: ["same"], url: nil))
        box.put(item, at: when)
        let first = box.defaults.dictionary(forKey: SharedInbox.key)?["id"] as? String
        box.put(item, at: when)
        let second = box.defaults.dictionary(forKey: SharedInbox.key)?["id"] as? String
        XCTAssertNotNil(first)
        XCTAssertNotNil(second)
        XCTAssertNotEqual(first, second)
    }

    func testAShareWrittenAfterTheReadIsNotRemoved() throws {
        let box = inbox()
        let when = Date(timeIntervalSince1970: 1_800_000_000)
        box.put(try XCTUnwrap(SharedItem(texts: ["first"], url: nil)), at: when)
        let read = box.defaults.dictionary(forKey: SharedInbox.key)

        // The extension writes a newer share (same millisecond) between the
        // app's read and its remove.
        box.put(try XCTUnwrap(SharedItem(texts: ["second"], url: nil)), at: when)
        box.remove(ifStill: read)

        XCTAssertEqual(box.take()?.text, "second")
        XCTAssertNil(box.take())
    }

    func testRemoveIfStillRemovesTheSameEntry() throws {
        let box = inbox()
        box.put(try XCTUnwrap(SharedItem(texts: ["only"], url: nil)), at: Date())
        box.remove(ifStill: box.defaults.dictionary(forKey: SharedInbox.key))
        XCTAssertNil(box.defaults.object(forKey: SharedInbox.key))
        // Nothing read, nothing removed.
        box.put(try XCTUnwrap(SharedItem(texts: ["kept"], url: nil)), at: Date())
        box.remove(ifStill: nil)
        XCTAssertEqual(box.take()?.text, "kept")
    }

    func testAnEmptyOrMalformedInboxTakesNothing() {
        let box = inbox()
        XCTAssertNil(box.take())
        box.defaults.set(["text": 3], forKey: SharedInbox.key)
        XCTAssertNil(box.take())
        XCTAssertNil(box.defaults.object(forKey: SharedInbox.key))
    }
}
