import Combine
import Sparkle
import SwiftUI

/// Sparkle, as Almanac Desk runs it: a check once a day, what's new shown
/// before it installs, and the update applied on relaunch. The feed and the
/// key that every update must be signed with are in macos/Info.plist.
@MainActor
enum AppUpdater {
    static let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    static var updater: SPUUpdater { controller.updater }
}

/// Whether Sparkle can check right now (it cannot while a check is running).
@MainActor
final class UpdateCheckState: ObservableObject {
    @Published var canCheck = false

    init() {
        AppUpdater.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
    }
}

/// RoleModel Studio > Check for Updates…
struct CheckForUpdatesButton: View {
    @StateObject private var state = UpdateCheckState()

    var body: some View {
        Button("Check for Updates…") { AppUpdater.updater.checkForUpdates() }
            .disabled(!state.canCheck)
    }
}
