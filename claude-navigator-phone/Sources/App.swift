// Chief of Staff for the phone.
// The screens (Team, a staff member, Today, Recent) are the web page in Web/index.html, shown full screen.
// This file does three things for that page: reads the team files the Mac app keeps in iCloud Drive,
// lets you choose that folder once, and shows Claude over the top when you open or start a chat.

import SwiftUI
import WebKit
import UniformTypeIdentifiers

@main
struct ChiefOfStaffApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

final class Store: NSObject, ObservableObject, WKScriptMessageHandler, UIDocumentPickerDelegate {
    @Published var chatOpen = false
    @Published var chatTitle = "Claude"
    let ui: WKWebView
    let claude: WKWebView
    private let bookmarkKey = "teamFolderBookmark"

    override init() {
        let content = WKUserContentController()
        let uiConfig = WKWebViewConfiguration()
        uiConfig.userContentController = content
        ui = WKWebView(frame: .zero, configuration: uiConfig)
        let claudeConfig = WKWebViewConfiguration()
        claudeConfig.websiteDataStore = .default()          // the Claude sign-in is kept between launches
        claudeConfig.allowsInlineMediaPlayback = true
        claude = WKWebView(frame: .zero, configuration: claudeConfig)
        super.init()
        content.add(self, name: "phone")
        ui.scrollView.contentInsetAdjustmentBehavior = .never
        ui.scrollView.bounces = false
        ui.isOpaque = false
        claude.allowsBackForwardNavigationGestures = true
        if let page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") {
            ui.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
    }

    // Messages from the page: load the team, choose the folder, open a chat.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let what = body["do"] as? String else { return }
        switch what {
        case "load": sendData()
        case "pick": pickFolder()
        case "save": if let text = body["json"] as? String { saveChanges(text) }
        case "chat":
            guard let text = body["url"] as? String, let url = URL(string: text), url.scheme == "https",
                  let host = url.host, host == "claude.ai" || host.hasSuffix(".claude.ai") else { return }
            chatTitle = (body["title"] as? String) ?? "Claude"
            claude.load(URLRequest(url: url))
            chatOpen = true
        default: break
        }
    }

    func chatClosed() {
        chatOpen = false
        // Where the chat ended up, so a chat started here can be added to that staff member's work.
        let info: [String: Any] = ["url": claude.url?.absoluteString ?? "", "title": claude.title ?? ""]
        let text = (try? JSONSerialization.data(withJSONObject: info)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        ui.evaluateJavaScript("window.phoneChatClosed && window.phoneChatClosed(\(text))", completionHandler: nil)
    }

    // MARK: The team files

    private func folderURL() -> URL? {
        guard let saved = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: saved, bookmarkDataIsStale: &stale) else { return nil }
        if stale {
            let ok = url.startAccessingSecurityScopedResource()
            if let fresh = try? url.bookmarkData() { UserDefaults.standard.set(fresh, forKey: bookmarkKey) }
            if ok { url.stopAccessingSecurityScopedResource() }
        }
        return url
    }

    // A file in iCloud Drive may not be on the phone yet: ask for it, and read it once it is here.
    private func read(_ url: URL) -> Any? {
        try? FileManager.default.startDownloadingUbiquitousItem(at: url)
        var data: Data?
        var problem: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &problem) { at in data = try? Data(contentsOf: at) }
        guard let found = data else { return nil }
        return try? JSONSerialization.jsonObject(with: found)
    }

    func sendData() {
        guard let folder = folderURL() else { return deliver(["state": "none"]) }
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = folder.startAccessingSecurityScopedResource()
            defer { if ok { folder.stopAccessingSecurityScopedResource() } }
            var out: [String: Any] = ["state": "empty"]
            if let index = self.read(folder.appendingPathComponent("index.json")) as? [String: Any],
               let profiles = index["profiles"] as? [[String: Any]] {
                var teams: [String: Any] = [:]
                for profile in profiles {
                    guard let id = profile["id"] as? String, let file = profile["file"] as? String,
                          !file.contains("/"), file.hasSuffix(".json") else { continue }
                    if let team = self.read(folder.appendingPathComponent(file)) { teams[id] = team }
                }
                out = ["state": teams.isEmpty ? "empty" : "ok", "index": index, "teams": teams]
                if let done = self.read(folder.appendingPathComponent("mac-applied.json")) as? [String: Any], let ids = done["ids"] { out["applied"] = ids }
            }
            DispatchQueue.main.async { self.deliver(out) }
        }
    }

    // What you did on the phone, for the Mac to pick up: written beside the team files.
    func saveChanges(_ text: String) {
        guard let folder = folderURL(), let data = text.data(using: .utf8) else { return }
        DispatchQueue.global(qos: .utility).async {
            let ok = folder.startAccessingSecurityScopedResource()
            defer { if ok { folder.stopAccessingSecurityScopedResource() } }
            var problem: NSError?
            NSFileCoordinator().coordinate(writingItemAt: folder.appendingPathComponent("phone-changes.json"), options: .forReplacing, error: &problem) { at in
                try? data.write(to: at, options: .atomic)
            }
        }
    }

    private func deliver(_ payload: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: json, encoding: .utf8) else { return }
        ui.evaluateJavaScript("window.phoneData && window.phoneData(\(text))", completionHandler: nil)
    }

    // MARK: Choosing the folder (once)

    func pickFolder() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
        picker.delegate = self
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.first?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        top?.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        let ok = url.startAccessingSecurityScopedResource()
        if let bookmark = try? url.bookmarkData() { UserDefaults.standard.set(bookmark, forKey: bookmarkKey) }
        if ok { url.stopAccessingSecurityScopedResource() }
        sendData()
    }
}

struct WebHost: UIViewRepresentable {
    let view: WKWebView
    func makeUIView(context: Context) -> WKWebView { view }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct RootView: View {
    @StateObject private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some View {
        WebHost(view: store.ui)
            .ignoresSafeArea()
            .onChange(of: phase) { now in if now == .active { store.sendData() } }      // fresh each time you come back
            .fullScreenCover(isPresented: $store.chatOpen) {
                VStack(spacing: 0) {
                    HStack(spacing: 12) {
                        Button("Done") { store.chatClosed() }.font(.body.weight(.semibold))
                        Spacer()
                        Text(store.chatTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Button { store.claude.reload() } label: { Image(systemName: "arrow.clockwise") }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    Divider()
                    WebHost(view: store.claude)
                }
            }
    }
}
