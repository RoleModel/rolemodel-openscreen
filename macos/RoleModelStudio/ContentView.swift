import SwiftUI

/// The window: a native sidebar of the Studio's views beside the page.
struct ContentView: View {
    @EnvironmentObject private var server: StudioServer
    @EnvironmentObject private var web: StudioWeb
    @State private var showInspector = true

    var body: some View {
        NavigationSplitView {
            List {
                ForEach(StudioSection.all) { section in
                    if let title = section.title {
                        Section(title) { rows(section) }
                    } else {
                        rows(section)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 280)
            .disabled(!isReady)
            .scrollContentBackground(.hidden)
            .background(Color("StudioPanel"))
        } detail: {
            detail
                .background(Color("StudioBlack"))
                .navigationTitle(navigationTitle)
                .inspector(isPresented: inspectorShown) {
                    InspectorView()
                        .inspectorColumnWidth(min: 260, ideal: 320, max: 440)
                }
                .toolbar {
                    ToolbarItemGroup {
                        Button("Controls", systemImage: "sidebar.trailing") { showInspector.toggle() }
                            .help(showInspector ? "Hide the controls" : "Show the controls")
                            .disabled(web.inspector.isEmpty)
                        Button("Reload", systemImage: "arrow.clockwise", action: web.reload)
                            .help("Reload the page")
                            .disabled(!isReady)
                        Button("Open in Browser", systemImage: "safari", action: web.openInBrowser)
                            .help("Open this page in your browser")
                            .disabled(!isReady)
                    }
                }
        }
        .frame(minWidth: 900, minHeight: 600)
        .toolbarBackground(Color("StudioBlack"), for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
        .containerBackground(Color("StudioBlack"), for: .window)
        .preferredColorScheme(.dark)
        // The brand green, not the system accent: the page uses it for every
        // selected and primary thing, and a blue sidebar beside it reads as two apps.
        .tint(Color("AccentColor"))
        .onChange(of: server.state, initial: true) { _, state in
            if case let .ready(url) = state { web.load(url) }
        }
    }

    private func rows(_ section: StudioSection) -> some View {
        ForEach(section.destinations) { destination in
            SidebarRow(destination: destination, isCurrent: destination.id == web.currentView) {
                web.show(destination.id)
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch server.state {
        case .starting:
            ProgressView("Starting the Studio…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            StudioWebContainer(web: web)
                .ignoresSafeArea(edges: .bottom)
        case let .failed(reason):
            ContentUnavailableView {
                Label("The Studio could not start", systemImage: "exclamationmark.triangle")
            } description: {
                Text(reason)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .multilineTextAlignment(.leading)
            } actions: {
                Button("Try Again", action: server.start)
                    .keyboardShortcut(.defaultAction)
                Button("Show Log") { NSWorkspace.shared.activateFileViewerSelecting([StudioServer.logURL]) }
            }
        }
    }

    /// Shown while the open view has controls, unless it was closed by hand.
    private var inspectorShown: Binding<Bool> {
        Binding(
            get: { showInspector && isReady && !web.inspector.isEmpty },
            set: { showInspector = $0 }
        )
    }

    private var isReady: Bool {
        if case .ready = server.state { return true }
        return false
    }

    private var navigationTitle: String {
        web.currentView.flatMap(StudioDestination.named)?.title ?? "RoleModel Studio"
    }
}

private extension StudioDestination {
    static func named(_ id: String) -> StudioDestination? { StudioSection.destination(id) }
}

/// One view in the sidebar. Drawn by hand rather than with List selection,
/// because a List paints its selection in the system accent — blue on most
/// Macs — and the Studio's selected things are brand green everywhere else.
private struct SidebarRow: View {
    let destination: StudioDestination
    let isCurrent: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text(destination.title)
                    .fontWeight(isCurrent ? .semibold : .regular)
            } icon: {
                Image(systemName: destination.symbol)
                    .foregroundStyle(Color("BrandGreen"))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background(isCurrent ? Color("AccentColor").opacity(0.55) : .clear, in: .rect(cornerRadius: 6))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}
