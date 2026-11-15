// Fast answers: two quick ways to answer a spoken question without driving Claude's web page.
//
//  1. Claude's API, on the small fast model only (Claude Haiku 5.5). You paste your own API key once; it is kept in
//     the phone's Keychain and never shown to the page or written anywhere else. Each answer is short and capped.
//  2. Granola, asked directly for what was said or decided in meetings. You sign in once in the browser. The answer
//     is fetched when you ask and held only in memory: nothing from a meeting is saved on the phone.
//
// Neither sends email or changes anything: both only read and answer.

import Foundation
import Security
import CryptoKit
import AuthenticationServices
import UIKit

// MARK: Keychain (one small text value per name)

enum Keep {
    private static let service = "com.dupreez.claude-navigator-phone.fast"

    static func set(_ name: String, _ value: String?) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
        SecItemDelete(query as CFDictionary)
        guard let value = value, !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ name: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: Claude's API (the fast model only)

final class FastClaude {
    // The only model this app ever asks through the API. There is no setting that changes it.
    static let model = "claude-haiku-5-5"
    private static let keyName = "anthropic-api-key"
    var tell: ((String, [String: Any]) -> Void)?
    private var task: URLSessionDataTask?
    private var current = ""

    var hasKey: Bool { !(Keep.get(FastClaude.keyName) ?? "").isEmpty }

    func cancel() { task?.cancel(); task = nil; current = "" }

    // The key is typed into a system box with hidden text, and goes straight to the Keychain.
    func askForKey(from top: UIViewController?, done: @escaping () -> Void) {
        let box = UIAlertController(title: "Claude API key", message: "Paste your key from the Anthropic Console. It is kept in this phone’s Keychain and used only for the fast model.", preferredStyle: .alert)
        box.addTextField { field in field.isSecureTextEntry = true; field.placeholder = "sk-ant-…"; field.autocorrectionType = .no; field.autocapitalizationType = .none }
        box.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done() })
        if hasKey { box.addAction(UIAlertAction(title: "Remove the Key", style: .destructive) { _ in Keep.set(FastClaude.keyName, nil); done() }) }
        box.addAction(UIAlertAction(title: "Save", style: .default) { _ in
            let typed = (box.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !typed.isEmpty { Keep.set(FastClaude.keyName, typed) }
            done()
        })
        guard let top = top else { done(); return }
        top.present(box, animated: true)
    }

    // One short question, one short answer. `turns` are the last few things said, oldest first: [["role": "user", "text": "…"], …].
    func ask(id: String, system: String, turns: [[String: String]], maxTokens: Int) {
        cancel()
        guard let key = Keep.get(FastClaude.keyName), !key.isEmpty, let url = URL(string: "https://api.anthropic.com/v1/messages") else {
            tell?("driveApi", ["id": id, "error": "no key"]); return
        }
        var messages: [[String: Any]] = []
        for turn in turns.suffix(8) {
            guard let role = turn["role"], role == "user" || role == "assistant", let text = turn["text"], !text.isEmpty else { continue }
            if let last = messages.last, (last["role"] as? String) == role { continue }       // (turns must alternate)
            messages.append(["role": role, "content": String(text.prefix(12000))])
        }
        guard let first = messages.first, (first["role"] as? String) == "user", (messages.last?["role"] as? String) == "user" else {
            tell?("driveApi", ["id": id, "error": "nothing to ask"]); return
        }
        let body: [String: Any] = [
            "model": FastClaude.model,
            "max_tokens": max(64, min(600, maxTokens)),
            "system": String(system.prefix(6000)),
            "messages": messages,
            "thinking": ["type": "disabled"],             // a spoken answer wants speed, not deliberation
            "output_config": ["effort": "low"],
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        current = id
        let started = Date()
        let tell = self.tell
        task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.current == id else { return }
                self.current = ""
                let ms = Int(Date().timeIntervalSince(started) * 1000)
                if let error = error { tell?("driveApi", ["id": id, "error": String(error.localizedDescription.prefix(160)), "ms": ms]); return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let json = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] ?? [:]
                if status != 200 {
                    let said = ((json["error"] as? [String: Any])?["message"] as? String) ?? "the API answered \(status)"
                    tell?("driveApi", ["id": id, "error": String(said.prefix(200)), "status": status, "ms": ms]); return
                }
                let blocks = (json["content"] as? [[String: Any]]) ?? []
                let text = blocks.filter { ($0["type"] as? String) == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
                let usage = (json["usage"] as? [String: Any]) ?? [:]
                let stop = (json["stop_reason"] as? String) ?? ""
                if stop == "refusal" || text.isEmpty { tell?("driveApi", ["id": id, "error": stop == "refusal" ? "declined" : "empty answer", "ms": ms, "in": (usage["input_tokens"] as? Int) ?? 0, "out": (usage["output_tokens"] as? Int) ?? 0]); return }
                tell?("driveApi", ["id": id, "text": text, "ms": ms, "in": (usage["input_tokens"] as? Int) ?? 0, "out": (usage["output_tokens"] as? Int) ?? 0, "model": (json["model"] as? String) ?? ""])
            }
        }
        task?.resume()
    }
}

// MARK: Granola (meeting answers, read only)

final class FastGranola: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let endpoint = "https://mcp.granola.ai/mcp"
    private let redirect = "chiefofstaff://granola"
    var tell: ((String, [String: Any]) -> Void)?
    private var web: ASWebAuthenticationSession?
    private var access = ""
    private var until = Date.distantPast
    private var sessionID = ""
    private var protocolVersion = "2025-06-18"
    private var started = false
    private var rpc = 0
    private var trail: [String] = []                    // steps only, never a token or anything from a meeting
    private var working: Task<Void, Never>?

    struct Problem: Error { let step: String; let text: String }

    var connected: Bool { !(Keep.get("granola-client") ?? "").isEmpty && (!(Keep.get("granola-refresh") ?? "").isEmpty || !(Keep.get("granola-access") ?? "").isEmpty) }
    var steps: String { trail.suffix(40).joined(separator: "\n") }

    private func note(_ text: String) {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
        trail.append("\(f.string(from: Date())) \(text)"); if trail.count > 60 { trail.removeFirst() }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first?.keyWindow ?? ASPresentationAnchor()
    }

    func disconnect() {
        for name in ["granola-client", "granola-secret", "granola-token-endpoint", "granola-refresh", "granola-access", "granola-until"] { Keep.set(name, nil) }
        access = ""; until = .distantPast; sessionID = ""; started = false
    }

    private func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func random(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Problem(step: "reaching Granola", text: "no answer") }
        return (data, http)
    }

    private func getJSON(_ address: String) async -> [String: Any]? {
        guard let url = URL(string: address), url.scheme == "https" else { return nil }
        var request = URLRequest(url: url); request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, http) = try? await send(request) else { return nil }
        note("GET \(url.host ?? "")\(url.path) -> \(http.statusCode)")
        guard http.statusCode == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // Where to sign in: Granola's server says so itself.
    private func discover() async throws -> (meta: [String: Any], scopes: [String]) {
        guard let mcp = URL(string: endpoint), let host = mcp.host else { throw Problem(step: "reaching Granola", text: "bad address") }
        let origin = "https://\(host)"
        var metaAddress = ""
        var first = URLRequest(url: mcp); first.httpMethod = "POST"; first.timeoutInterval = 20
        first.setValue("application/json", forHTTPHeaderField: "Content-Type")
        first.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        first.httpBody = try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 0, "method": "initialize", "params": ["protocolVersion": "2025-06-18", "capabilities": [String: Any](), "clientInfo": ["name": "Chief of Staff", "version": "1"]]])
        do {
            let (_, http) = try await send(first)
            note("first call -> \(http.statusCode)")
            let header = (http.value(forHTTPHeaderField: "WWW-Authenticate") ?? "")
            if let range = header.range(of: "resource_metadata=") {
                let rest = header[range.upperBound...].trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                metaAddress = String(rest.prefix { $0 != "\"" && $0 != "," && $0 != " " })
            }
        } catch { throw Problem(step: "reaching Granola", text: error.localizedDescription) }
        var resource: [String: Any]?
        for address in [metaAddress, "\(origin)/.well-known/oauth-protected-resource\(mcp.path)", "\(origin)/.well-known/oauth-protected-resource"] where !address.isEmpty {
            resource = await getJSON(address); if resource != nil { break }
        }
        let issuer = ((resource?["authorization_servers"] as? [String])?.first) ?? origin
        guard let iu = URL(string: issuer), let ihost = iu.host else { throw Problem(step: "finding the sign-in", text: "bad sign-in address") }
        let io = "https://\(ihost)", p = iu.path.hasSuffix("/") ? String(iu.path.dropLast()) : iu.path
        var meta: [String: Any]?
        for address in ["\(io)/.well-known/oauth-authorization-server\(p)", "\(io)\(p)/.well-known/oauth-authorization-server", "\(io)/.well-known/openid-configuration\(p)", "\(io)\(p)/.well-known/openid-configuration"] {
            if let found = await getJSON(address), found["authorization_endpoint"] is String, found["token_endpoint"] is String { meta = found; break }
        }
        guard let got = meta else { throw Problem(step: "finding the sign-in", text: "Granola did not say where to sign in") }
        for key in ["authorization_endpoint", "token_endpoint", "registration_endpoint"] {
            if let value = got[key] as? String, !value.hasPrefix("https://") { throw Problem(step: "finding the sign-in", text: "the sign-in address is not a secure one") }
        }
        let scopes = (resource?["scopes_supported"] as? [String]) ?? (got["scopes_supported"] as? [String]) ?? []
        return (got, scopes)
    }

    private func form(_ fields: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        return fields.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&").data(using: .utf8) ?? Data()
    }

    private func tokenRequest(_ fields: [String: String]) async throws -> String {
        guard let address = Keep.get("granola-token-endpoint"), let url = URL(string: address), let client = Keep.get("granola-client") else { throw Problem(step: "signing in", text: "Granola is not connected yet") }
        var all = fields; all["client_id"] = client; all["resource"] = endpoint
        if let secret = Keep.get("granola-secret"), !secret.isEmpty { all["client_secret"] = secret }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 25
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = form(all)
        let (data, http) = try await send(request)
        let json = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        note("token (\(fields["grant_type"] ?? "")) -> \(http.statusCode)\((json["error"] as? String).map { " " + $0 } ?? "")")
        guard http.statusCode == 200, let token = json["access_token"] as? String, !token.isEmpty else {
            throw Problem(step: "signing in", text: (json["error_description"] as? String) ?? (json["error"] as? String) ?? "the sign-in server answered \(http.statusCode)")
        }
        let life = (json["expires_in"] as? Double) ?? 3600
        access = token; until = Date().addingTimeInterval(max(60, life - 120))
        Keep.set("granola-access", token); Keep.set("granola-until", String(until.timeIntervalSince1970))
        if let refresh = json["refresh_token"] as? String, !refresh.isEmpty { Keep.set("granola-refresh", refresh) }
        return token
    }

    private func token() async throws -> String {
        if !access.isEmpty, Date() < until { return access }
        if access.isEmpty, let kept = Keep.get("granola-access"), let t = Double(Keep.get("granola-until") ?? ""), Date().timeIntervalSince1970 < t { access = kept; until = Date(timeIntervalSince1970: t); return kept }
        guard let refresh = Keep.get("granola-refresh"), !refresh.isEmpty else { throw Problem(step: "signing in", text: "The Granola sign-in has run out. Connect again.") }
        do { return try await tokenRequest(["grant_type": "refresh_token", "refresh_token": refresh]) }
        catch { throw Problem(step: "signing in", text: "The Granola sign-in has run out. Connect again.") }
    }

    // You sign in once, in the phone's own browser sheet. The result is reported to the page as driveGranState.
    func connect() {
        working?.cancel()
        working = Task { @MainActor in
            trail = []; sessionID = ""; started = false
            do {
                let found = try await discover()
                guard let registration = found.meta["registration_endpoint"] as? String, let regURL = URL(string: registration) else { throw Problem(step: "registering the app", text: "Granola does not let a new app register itself") }
                var reg = URLRequest(url: regURL); reg.httpMethod = "POST"; reg.timeoutInterval = 25
                reg.setValue("application/json", forHTTPHeaderField: "Content-Type"); reg.setValue("application/json", forHTTPHeaderField: "Accept")
                reg.httpBody = try? JSONSerialization.data(withJSONObject: ["client_name": "Chief of Staff (phone)", "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none", "application_type": "native"])
                let (regData, regHTTP) = try await send(reg)
                let rj = ((try? JSONSerialization.jsonObject(with: regData)) as? [String: Any]) ?? [:]
                note("register -> \(regHTTP.statusCode)\((rj["error"] as? String).map { " " + $0 } ?? "")")
                guard (200...201).contains(regHTTP.statusCode), let client = rj["client_id"] as? String else {
                    throw Problem(step: "registering the app", text: (rj["error_description"] as? String) ?? (rj["error"] as? String) ?? "Granola answered \(regHTTP.statusCode)")
                }
                disconnect()
                Keep.set("granola-client", client); Keep.set("granola-secret", (rj["client_secret"] as? String) ?? "")
                Keep.set("granola-token-endpoint", (found.meta["token_endpoint"] as? String) ?? "")
                let verifier = b64url(random(48)), state = b64url(random(16))
                let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
                guard var parts = URLComponents(string: (found.meta["authorization_endpoint"] as? String) ?? "") else { throw Problem(step: "signing in", text: "bad sign-in address") }
                var items = parts.queryItems ?? []
                items += [URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: client), URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "state", value: state),
                          URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "resource", value: endpoint)]
                if !found.scopes.isEmpty { items.append(URLQueryItem(name: "scope", value: found.scopes.joined(separator: " "))) }
                parts.queryItems = items
                guard let authURL = parts.url else { throw Problem(step: "signing in", text: "bad sign-in address") }
                note("browser opened for sign-in")
                let back: URL = try await withCheckedThrowingContinuation { resume in
                    let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: "chiefofstaff") { url, error in
                        if let url = url { resume.resume(returning: url) }
                        else { resume.resume(throwing: Problem(step: "signing in", text: (error as NSError?)?.code == ASWebAuthenticationSessionError.canceledLogin.rawValue ? "Signing in was cancelled" : (error?.localizedDescription ?? "Signing in did not finish"))) }
                    }
                    session.presentationContextProvider = self
                    session.prefersEphemeralWebBrowserSession = false
                    self.web = session
                    if !session.start() { resume.resume(throwing: Problem(step: "signing in", text: "The sign-in page could not be opened")) }
                }
                note("came back from the browser")
                let query = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let value: (String) -> String = { name in query.first { $0.name == name }?.value ?? "" }
                guard value("state") == state, !value("code").isEmpty else { throw Problem(step: "signing in", text: value("error_description").isEmpty ? (value("error").isEmpty ? "Signing in was cancelled" : value("error")) : value("error_description")) }
                do { _ = try await tokenRequest(["grant_type": "authorization_code", "code": value("code"), "redirect_uri": redirect, "code_verifier": verifier]) }
                catch let p as Problem { throw Problem(step: "finishing the sign-in", text: p.text) }
                let names = try await toolNames()
                note("tools: \(names.joined(separator: ", "))")
                tell?("driveGranState", ["on": true, "tools": names.count, "steps": steps])
            } catch let p as Problem {
                note("stopped while \(p.step): \(p.text)")
                tell?("driveGranState", ["on": connected, "error": "\(p.step): \(p.text)", "steps": steps])
            } catch {
                note("stopped: \(error.localizedDescription)")
                tell?("driveGranState", ["on": connected, "error": String(error.localizedDescription.prefix(160)), "steps": steps])
            }
        }
    }

    // One request to Granola's server. Its answers come either as plain JSON or as a short stream of "data:" lines.
    private func post(_ body: [String: Any], seconds: Double, again: Bool = false) async throws -> (result: [String: Any]?, http: HTTPURLResponse) {
        let bearer = try await token()
        guard let url = URL(string: endpoint) else { throw Problem(step: "reaching Granola", text: "bad address") }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = seconds
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        if started { if !sessionID.isEmpty { request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id") }; request.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version") }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let (data, http) = try await send(request)
        let method = (body["method"] as? String) ?? ""
        note("\(method) -> \(http.statusCode)")
        if http.statusCode == 401 && !again { access = ""; until = .distantPast; Keep.set("granola-access", nil); Keep.set("granola-until", nil); return try await post(body, seconds: seconds, again: true) }
        if http.statusCode == 404 && started && !again && method != "initialize" { started = false; sessionID = ""; try await start(); return try await post(body, seconds: seconds, again: true) }
        guard let wanted = body["id"] as? Int else { return (nil, http) }
        let text = String(data: data, encoding: .utf8) ?? ""
        guard (200...299).contains(http.statusCode) else { throw Problem(step: "asking Granola", text: "Granola answered \(http.statusCode)") }
        var message: [String: Any]?
        if (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("event-stream") {
            for line in text.components(separatedBy: .newlines) where line.hasPrefix("data:") {
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                if let found = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any], (found["id"] as? Int) == wanted { message = found }
            }
        } else { message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
        guard let got = message else { throw Problem(step: "asking Granola", text: "Granola’s answer could not be read") }
        if let failure = got["error"] as? [String: Any] { throw Problem(step: "asking Granola", text: (failure["message"] as? String) ?? "Granola reported a problem") }
        return (got["result"] as? [String: Any], http)
    }

    private func start() async throws {
        if started { return }
        rpc += 1
        let (result, http) = try await post(["jsonrpc": "2.0", "id": rpc, "method": "initialize", "params": ["protocolVersion": "2025-06-18", "capabilities": [String: Any](), "clientInfo": ["name": "Chief of Staff", "version": "1"]]], seconds: 30)
        sessionID = http.value(forHTTPHeaderField: "Mcp-Session-Id") ?? ""
        protocolVersion = (result?["protocolVersion"] as? String) ?? "2025-06-18"
        started = true
        _ = try? await post(["jsonrpc": "2.0", "method": "notifications/initialized"], seconds: 20)
    }

    private func toolNames() async throws -> [String] {
        try await start()
        rpc += 1
        let (result, _) = try await post(["jsonrpc": "2.0", "id": rpc, "method": "tools/list", "params": [String: Any]()], seconds: 30)
        return ((result?["tools"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
    }

    // The phone only ever asks Granola one thing: a question about your meetings. It cannot change anything there.
    func ask(id: String, question: String) {
        working?.cancel()
        let began = Date()
        working = Task { @MainActor in
            do {
                try await start()
                rpc += 1
                let (result, _) = try await post(["jsonrpc": "2.0", "id": rpc, "method": "tools/call", "params": ["name": "query_granola_meetings", "arguments": ["query": String(question.prefix(1500))]]], seconds: 90)
                if Task.isCancelled { return }
                let blocks = (result?["content"] as? [[String: Any]]) ?? []
                let text = blocks.filter { ($0["type"] as? String) == "text" }.compactMap { $0["text"] as? String }.joined(separator: "\n")
                let ms = Int(Date().timeIntervalSince(began) * 1000)
                if (result?["isError"] as? Bool) == true || text.isEmpty { tell?("driveGran", ["id": id, "error": "Granola could not answer that", "ms": ms]); return }
                tell?("driveGran", ["id": id, "text": String(text.prefix(6000)), "ms": ms])
            } catch let p as Problem {
                if Task.isCancelled { return }
                note("stopped while \(p.step): \(p.text)")
                tell?("driveGran", ["id": id, "error": "\(p.step): \(p.text)", "ms": Int(Date().timeIntervalSince(began) * 1000)])
            } catch {
                if Task.isCancelled { return }
                tell?("driveGran", ["id": id, "error": String(error.localizedDescription.prefix(160)), "ms": Int(Date().timeIntervalSince(began) * 1000)])
            }
        }
    }

    func cancel() { working?.cancel(); working = nil }
}
