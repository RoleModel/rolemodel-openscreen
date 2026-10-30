import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// The one web view the window shows, and the bridge between it and the native chrome.
///
/// The page keeps its own navigation in `go(view)`, a global in studio.js. The
/// native sidebar calls it, and a wrapper around it reports every change back,
/// so the sidebar follows navigation the page starts itself (a step on the
/// Video rail, a breadcrumb, a link on a card).
@MainActor
final class StudioWeb: NSObject, ObservableObject {
    @Published private(set) var currentView: String?
    @Published private(set) var title = "RoleModel Studio"
    /// The page's right-hand panel, read for the native inspector. Empty when
    /// the view has no panel.
    @Published private(set) var inspector: [InspectorItem] = []
    @Published private(set) var palette: [InspectorSwatchFamily] = []

    let webView: WKWebView
    private var origin: URL?

    /// Both of the page's side panels are replaced by native ones.
    private static let chromeCSS = """
    .op-page > .op-page__sidebar:not(.op-page__sidebar--right) { display: none !important; }
    \(InspectorBridge.hidePanelCSS)
    """

    private static let bridgeJS = """
    (() => {
      const post = (v) => window.webkit.messageHandlers.studio.postMessage({ view: v ?? null })
      const current = () => { try { return view } catch { return null } }
      if (typeof window.go === 'function' && !window.go.studioWrapped) {
        const original = window.go
        const wrapped = function (...args) {
          const result = original.apply(this, args)
          post(current() ?? args[0])
          return result
        }
        wrapped.studioWrapped = true
        window.go = wrapped
      }
      // Not every change of view goes through go(): the boot restores the last
      // view by setting it and drawing. Every view draws into #main, so watch that.
      let last
      const report = () => {
        const v = current()
        if (v !== last) { last = v; post(v) }
      }
      const main = document.getElementById('main')
      if (main) new MutationObserver(() => requestAnimationFrame(report)).observe(main, { childList: true })
      report()
    })()
    """

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = "RoleModelStudioMac/\(Bundle.main.shortVersion)"
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let controller = configuration.userContentController
        let style = "const s = document.createElement('style'); s.textContent = \(Self.jsString(Self.chromeCSS)); document.documentElement.appendChild(s);"
        controller.addUserScript(WKUserScript(source: style, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: InspectorBridge.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        super.init()

        controller.add(WeakMessageHandler(self), name: "studio")
        controller.add(WeakMessageHandler(self), name: "inspector")
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    func load(_ url: URL) {
        guard origin != url else { return }
        origin = url
        webView.load(URLRequest(url: url))
    }

    func show(_ view: String) {
        currentView = view
        webView.evaluateJavaScript("go(\(Self.jsString(view)))")
    }

    func reload() {
        webView.reload()
    }

    func openInBrowser() {
        guard let url = webView.url ?? origin else { return }
        NSWorkspace.shared.open(url)
    }

    /// Clicks one of the page's own buttons that lived in the hidden sidebar.
    func press(_ elementID: String) {
        webView.evaluateJavaScript("document.getElementById(\(Self.jsString(elementID)))?.click()")
    }

    /// Sets a control in the page's panel. The native copy changes at once, so a
    /// slider does not wait a round trip to move; the page's next reading confirms it.
    func inspectorSet(_ id: String, value: String, commit: Bool) {
        if let at = inspector.firstIndex(where: { $0.id == id }) {
            if inspector[at].kind == .checkbox {
                inspector[at].checked = value == "true"
            } else {
                inspector[at].value = value
            }
        } else if let at = inspector.firstIndex(where: { $0.toggleID == id }) {
            inspector[at].toggleOn = value == "true"
        }
        webView.evaluateJavaScript("window.__studioInspector?.set(\(Self.jsString(id)), \(Self.jsString(value)), \(commit))")
    }

    func inspectorPress(_ id: String) {
        webView.evaluateJavaScript("window.__studioInspector?.press(\(Self.jsString(id)))")
    }

    func inspectorSwatch(_ id: String, title: String) {
        webView.evaluateJavaScript("window.__studioInspector?.swatch(\(Self.jsString(id)), \(Self.jsString(title)))")
    }

    private func isStudio(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.host == origin.host && url.port == origin.port
    }

    private static func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }
}

// MARK: - Messages from the page

extension StudioWeb: WKScriptMessageHandler {
    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            let body = message.body as? [String: Any]
            if message.name == "inspector" {
                receiveInspector(body)
            } else if let view = body?["view"] as? String {
                currentView = view
            }
        }
    }

    private func receiveInspector(_ body: [String: Any]?) {
        guard let body else { return }
        let decoder = JSONDecoder()
        if let items = body["items"],
           let data = try? JSONSerialization.data(withJSONObject: items),
           let decoded = try? decoder.decode([InspectorItem].self, from: data),
           decoded != inspector {
            inspector = decoded
        }
        if palette.isEmpty, let families = body["palette"], !(families is NSNull),
           let data = try? JSONSerialization.data(withJSONObject: families),
           let decoded = try? decoder.decode([InspectorSwatchFamily].self, from: data) {
            palette = decoded
        }
    }
}

/// WKUserContentController holds its handlers strongly; this breaks the cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

// MARK: - Navigation and downloads

extension StudioWeb: WKNavigationDelegate, WKDownloadDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }
        // A link out of the Studio opens in the browser, not in place of the app.
        if action.targetFrame?.isMainFrame ?? true, action.navigationType == .linkActivated,
           let url = action.request.url, !isStudio(url) {
            NSWorkspace.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if let http = response.response as? HTTPURLResponse,
           http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true {
            return .download
        }
        return response.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let pageTitle = webView.title, !pageTitle.isEmpty { title = pageTitle }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        var destination = downloads.appending(path: name)
        let stem = destination.deletingPathExtension().lastPathComponent
        let ext = destination.pathExtension
        var copy = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = downloads.appending(path: ext.isEmpty ? "\(stem) \(copy)" : "\(stem) \(copy).\(ext)")
            copy += 1
        }
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSSound(named: "Glass")?.play()
    }
}

// MARK: - Panels the page asks for

extension StudioWeb: WKUIDelegate {
    /// `window.open` and `target="_blank"`: the browser, not a second web view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        return await panel.begin() == .OK ? panel.urls : nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }

    /// The camera and microphone, for the Studio's own pages only.
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                 initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        let studio = self.origin
        return origin.host == studio?.host && origin.port == studio?.port ?? 0 ? .grant : .prompt
    }
}

/// Puts the shared web view into the SwiftUI layout.
struct StudioWebContainer: NSViewRepresentable {
    let web: StudioWeb

    func makeNSView(context: Context) -> WKWebView { web.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

extension Bundle {
    var shortVersion: String {
        infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }
}
