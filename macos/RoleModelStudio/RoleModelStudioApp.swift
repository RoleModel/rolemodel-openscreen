import SwiftUI

@main
struct RoleModelStudioApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // One window: there is one server, and two windows on it would each
        // think they owned the page's state.
        Window("RoleModel Studio", id: "main") {
            ContentView()
                .environmentObject(appDelegate.server)
                .environmentObject(appDelegate.web)
        }
        .defaultSize(width: 1400, height: 900)
        .commands { StudioCommands(server: appDelegate.server, web: appDelegate.web) }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let server = StudioServer()
    let web = StudioWeb()

    func applicationWillFinishLaunching(_ notification: Notification) {
        // The Studio's pages are dark, always; the frame around them matches.
        NSApp.appearance = NSAppearance(named: .darkAqua)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = AppUpdater.controller
        server.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        true
    }
}

/// The menus: every view under Go, with ⌘1–⌘9 for the video steps.
struct StudioCommands: Commands {
    let server: StudioServer
    let web: StudioWeb

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            CheckForUpdatesButton()
            Divider()
            Button("Sign Out of Canvas") { web.press("signout") }
        }
        CommandGroup(replacing: .newItem) {}

        CommandGroup(before: .toolbar) {
            Button("Reload Page", action: web.reload)
                .keyboardShortcut("r")
            Button("Open in Browser", action: web.openInBrowser)
                .keyboardShortcut("o", modifiers: [.command, .shift])
            Button("Restart the Studio", action: server.start)
            Divider()
        }

        CommandMenu("Go") {
            let shortcuts = Array("123456789")
            let numbered = StudioSection.all.flatMap(\.destinations).prefix(shortcuts.count)
            ForEach(StudioSection.all) { section in
                Section(section.title ?? "") {
                    ForEach(section.destinations) { destination in
                        let button = Button(destination.title) { web.show(destination.id) }
                        if let at = numbered.firstIndex(of: destination) {
                            button.keyboardShortcut(KeyEquivalent(shortcuts[at]))
                        } else {
                            button
                        }
                    }
                }
            }
        }

        CommandGroup(replacing: .help) {
            Button("RoleModel Studio Docs") { web.press("docs") }
            Button("Show Studio Log") {
                NSWorkspace.shared.activateFileViewerSelecting([StudioServer.logURL])
            }
        }
    }
}
