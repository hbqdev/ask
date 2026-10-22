import Capacitor
import Foundation

/// Hands the app what the Share extension (AskShare) left in the App Group
/// inbox. @capacitor/preferences cannot read an App Group suite, hence this
/// one-method plugin; src/core/shared-inbox.ts is its JS side.
/// Registered on the bridge in AskBridgeViewController.capacitorDidLoad().
@objc(SharedInboxPlugin)
public class SharedInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedInboxPlugin"
    public let jsName = "SharedInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "take", returnType: CAPPluginReturnPromise),
    ]

    /// The waiting item, { text, createdAt (ms) }, removed from the inbox in
    /// the same step; {} when there is none.
    @objc func take(_ call: CAPPluginCall) {
        guard let item = SharedInbox.appGroupInbox()?.take() else {
            call.resolve([:])
            return
        }
        call.resolve(["text": item.text, "createdAt": item.createdAt])
    }
}
