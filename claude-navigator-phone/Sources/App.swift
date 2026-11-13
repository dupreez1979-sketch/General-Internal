// Chief of Staff for the phone: test build 1.
// It does one thing: shows Claude inside the app, to prove that you can sign in once and stay signed in.
// The team, Today and the rest come after this works.

import SwiftUI
import WebKit

@main
struct ChiefOfStaffApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

final class ClaudePage: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var address = ""
    @Published var loading = true
    let view: WKWebView

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // the sign-in is kept between launches
        config.allowsInlineMediaPlayback = true
        view = WKWebView(frame: .zero, configuration: config)
        super.init()
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.load(URLRequest(url: URL(string: "https://claude.ai/new")!))
    }

    // Signed in means Claude has taken us past its sign-in pages.
    var signedIn: Bool {
        guard let url = URL(string: address), let host = url.host, host.hasSuffix("claude.ai") else { return false }
        return !url.path.hasPrefix("/login") && !url.path.hasPrefix("/logout") && !url.path.hasPrefix("/magic-link")
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false; address = webView.url?.absoluteString ?? "" }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { address = webView.url?.absoluteString ?? "" }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loading = false }
}

struct ClaudeView: UIViewRepresentable {
    let page: ClaudePage
    func makeUIView(context: Context) -> WKWebView { page.view }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct ContentView: View {
    @StateObject private var page = ClaudePage()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(page.signedIn ? Color.green : Color.orange).frame(width: 10, height: 10)
                Text(page.loading ? "Loading…" : page.signedIn ? "Signed in to Claude" : "Not signed in yet: use Continue with email")
                    .font(.footnote.weight(.semibold))
                Spacer()
                Button("Reload") { page.view.reload() }.font(.footnote)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(Color(red: 0.11, green: 0.35, blue: 0.41).opacity(0.12))
            ClaudeView(page: page)
        }
    }
}
