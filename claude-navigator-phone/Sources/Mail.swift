// Your email and calendar, read only.
//
// The phone signs in to Microsoft itself, in the phone's own browser sheet, and asks for permission to READ mail and
// calendars and nothing else. It cannot send, change or delete anything: Microsoft would refuse, because the
// permission was never asked for. The sign-in is kept in this phone's Keychain. What is read is fetched when a
// question needs it, handed to Claude's fast model for that one answer, and not saved on the phone.

import Foundation
import CryptoKit
import AuthenticationServices
import UIKit

final class FastMicrosoft: NSObject, ASWebAuthenticationPresentationContextProviding {
    // The app's registration with Microsoft (an identifier, not a secret; there is no client secret).
    private static let client = "dab5446b-4bd7-4764-8d0e-4a5cdc747487"
    private let authority = "https://login.microsoftonline.com/common/oauth2/v2.0"
    private let scheme = "msauth.com.dupreez.claude-navigator-phone"
    private var redirect: String { scheme + "://auth" }
    private let scope = "offline_access User.Read Mail.Read Calendars.Read"
    private let graph = "https://graph.microsoft.com/v1.0"

    var tell: ((String, [String: Any]) -> Void)?
    private var web: ASWebAuthenticationSession?
    private var working: Task<Void, Never>?
    private var tokens: [String: String] = [:]
    private var until: [String: Date] = [:]
    private var refs: [[String: String]] = []            // emails found in this one question: ["acc": id, "id": message id]

    struct Problem: Error { let text: String }

    // The accounts signed in on this phone: [["id": …, "email": …, "name": …]]. No token is ever in this list.
    var accounts: [[String: String]] {
        guard let raw = Keep.get("ms-accounts"), let data = raw.data(using: .utf8), let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]] else { return [] }
        return list
    }
    var emails: [String] { accounts.compactMap { $0["email"] } }
    var connected: Bool { !accounts.isEmpty }

    private func saveAccounts(_ list: [[String: String]]) {
        let data = (try? JSONSerialization.data(withJSONObject: list)) ?? Data()
        Keep.set("ms-accounts", list.isEmpty ? nil : String(data: data, encoding: .utf8))
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first?.keyWindow ?? ASPresentationAnchor()
    }

    func resetRefs() { refs = [] }

    func disconnect(_ email: String) {
        var list = accounts
        for a in list where (a["email"] ?? "") == email || email.isEmpty { if let id = a["id"] { Keep.set("ms-refresh-" + id, nil); tokens[id] = nil; until[id] = nil } }
        list.removeAll { ($0["email"] ?? "") == email || email.isEmpty }
        saveAccounts(list)
        tell?("driveMailState", ["accounts": emails])
    }

    private func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func random(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }
    private func form(_ fields: [String: String]) -> Data {
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        let text = fields.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
        return Data(text.utf8)
    }

    // Microsoft's token address: a code or a refresh token goes in, an access token (and a newer refresh token) comes out.
    private func tokenRequest(_ fields: [String: String]) async throws -> [String: Any] {
        guard let url = URL(string: authority + "/token") else { throw Problem(text: "bad address") }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 25
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var all = fields; all["client_id"] = FastMicrosoft.client; all["scope"] = scope
        request.httpBody = form(all)
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, json["access_token"] is String else {
            let said = (json["error_description"] as? String) ?? (json["error"] as? String) ?? "Microsoft answered \(status)"
            throw Problem(text: String(said.split(separator: "\n").first ?? "").prefix(180).description)
        }
        return json
    }

    private func token(for id: String) async throws -> String {
        if let t = tokens[id], let u = until[id], u.timeIntervalSinceNow > 120 { return t }
        guard let refresh = Keep.get("ms-refresh-" + id), !refresh.isEmpty else { throw Problem(text: "Sign in to this account again") }
        let json = try await tokenRequest(["grant_type": "refresh_token", "refresh_token": refresh])
        let access = (json["access_token"] as? String) ?? ""
        if let newer = json["refresh_token"] as? String, !newer.isEmpty { Keep.set("ms-refresh-" + id, newer) }
        tokens[id] = access; until[id] = Date().addingTimeInterval(TimeInterval((json["expires_in"] as? Int) ?? 3000))
        return access
    }

    private func get(_ id: String, _ path: String, query: [URLQueryItem] = [], text: Bool = false) async throws -> [String: Any] {
        guard var parts = URLComponents(string: graph + path) else { throw Problem(text: "bad address") }
        if !query.isEmpty { parts.queryItems = query }
        guard let url = parts.url else { throw Problem(text: "bad address") }
        var request = URLRequest(url: url); request.timeoutInterval = 15
        request.setValue("Bearer " + (try await token(for: id)), forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if text { request.setValue("outlook.body-content-type=\"text\"", forHTTPHeaderField: "Prefer") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        guard status == 200 else { throw Problem(text: (((json["error"] as? [String: Any])?["message"] as? String) ?? "Microsoft answered \(status)").prefix(160).description) }
        return json
    }

    // You sign in once per account, in the phone's own browser sheet. The result is reported to the page as driveMailState.
    func connect() {
        working?.cancel()
        working = Task { @MainActor in
            do {
                let verifier = b64url(random(48)), state = b64url(random(16))
                let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
                guard var parts = URLComponents(string: authority + "/authorize") else { throw Problem(text: "bad sign-in address") }
                parts.queryItems = [URLQueryItem(name: "client_id", value: FastMicrosoft.client), URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "redirect_uri", value: redirect),
                                    URLQueryItem(name: "response_mode", value: "query"), URLQueryItem(name: "scope", value: scope), URLQueryItem(name: "state", value: state),
                                    URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "prompt", value: "select_account")]
                guard let authURL = parts.url else { throw Problem(text: "bad sign-in address") }
                let callback = scheme
                let back: URL = try await withCheckedThrowingContinuation { resume in
                    let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callback) { url, error in
                        if let url = url { resume.resume(returning: url) }
                        else { resume.resume(throwing: Problem(text: (error as NSError?)?.code == ASWebAuthenticationSessionError.canceledLogin.rawValue ? "Signing in was cancelled" : String((error?.localizedDescription ?? "Signing in did not finish").prefix(160)))) }
                    }
                    session.presentationContextProvider = self
                    session.prefersEphemeralWebBrowserSession = false
                    self.web = session
                    if !session.start() { resume.resume(throwing: Problem(text: "The sign-in page could not be opened")) }
                }
                let items = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let value: (String) -> String = { name in items.first { $0.name == name }?.value ?? "" }
                guard value("state") == state, !value("code").isEmpty else {
                    let said = value("error_description").isEmpty ? (value("error").isEmpty ? "Signing in was cancelled" : value("error")) : value("error_description")
                    throw Problem(text: String(said.replacingOccurrences(of: "+", with: " ").prefix(180)))
                }
                let json = try await tokenRequest(["grant_type": "authorization_code", "code": value("code"), "redirect_uri": redirect, "code_verifier": verifier])
                let access = (json["access_token"] as? String) ?? ""
                guard let refresh = json["refresh_token"] as? String, !refresh.isEmpty else { throw Problem(text: "Microsoft did not let the phone stay signed in") }
                // who signed in
                guard let meURL = URL(string: graph + "/me?$select=id,mail,userPrincipalName,displayName") else { throw Problem(text: "bad address") }
                var meRequest = URLRequest(url: meURL); meRequest.timeoutInterval = 15
                meRequest.setValue("Bearer " + access, forHTTPHeaderField: "Authorization")
                let (meData, _) = try await URLSession.shared.data(for: meRequest)
                let me = ((try? JSONSerialization.jsonObject(with: meData)) as? [String: Any]) ?? [:]
                guard let id = me["id"] as? String, !id.isEmpty else { throw Problem(text: "Microsoft did not say whose account this is") }
                let email = ((me["mail"] as? String) ?? (me["userPrincipalName"] as? String) ?? "").lowercased()
                Keep.set("ms-refresh-" + id, refresh)
                tokens[id] = access; until[id] = Date().addingTimeInterval(TimeInterval((json["expires_in"] as? Int) ?? 3000))
                var list = accounts.filter { ($0["id"] ?? "") != id }
                list.append(["id": id, "email": email, "name": (me["displayName"] as? String) ?? ""])
                saveAccounts(list)
                tell?("driveMailState", ["accounts": emails])
            } catch let p as Problem {
                tell?("driveMailState", ["accounts": emails, "error": p.text])
            } catch {
                tell?("driveMailState", ["accounts": emails, "error": String(error.localizedDescription.prefix(160))])
            }
        }
    }

    // A quick yes or no for Run Checks: can the first account's inbox be read right now?
    func check() async -> String {
        guard let first = accounts.first, let id = first["id"] else { return "not connected" }
        let started = Date()
        do {
            let json = try await get(id, "/me/messages", query: [URLQueryItem(name: "$top", value: "1"), URLQueryItem(name: "$select", value: "id")])
            let n = ((json["value"] as? [[String: Any]]) ?? []).count
            return "read \(n) message in \(Int(Date().timeIntervalSince(started) * 1000)) ms, \(accounts.count) account\(accounts.count == 1 ? "" : "s")"
        } catch let p as Problem { return "FAILED: " + p.text } catch { return "FAILED: " + String(error.localizedDescription.prefix(120)) }
    }

    // MARK: What Claude's fast model may look at. All three only read.

    static let tools: [[String: Any]] = [
        ["name": "search_email", "description": "Search his email (all folders, every account signed in on this phone). Returns up to 8 emails, newest first, each with a ref, who it is from, the date, the subject and its first lines.",
         "input_schema": ["type": "object", "properties": ["query": ["type": "string", "description": "A few plain words to search for: a name, a subject, a topic."]], "required": ["query"]]],
        ["name": "read_email", "description": "Read one email in full. Use only when the first lines from search_email are not enough.",
         "input_schema": ["type": "object", "properties": ["ref": ["type": "string", "description": "The ref search_email gave, such as m2."]], "required": ["ref"]]],
        ["name": "calendar", "description": "List what is in his calendar between two dates (both included).",
         "input_schema": ["type": "object", "properties": ["from": ["type": "string", "description": "First day, as YYYY-MM-DD."], "to": ["type": "string", "description": "Last day, as YYYY-MM-DD."]], "required": ["from", "to"]]],
    ]

    private func who(_ any: Any?) -> String {
        let address = ((any as? [String: Any])?["emailAddress"] as? [String: Any]) ?? [:]
        return (address["name"] as? String) ?? (address["address"] as? String) ?? "unknown"
    }
    private func utc(_ text: String) -> Date? {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: String(text.prefix(19)))
    }
    private func show(_ date: Date, _ format: String) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_AU"); f.dateFormat = format
        return f.string(from: date)
    }

    func run(_ name: String, _ input: [String: Any]) async -> String {
        let list = Array(accounts.prefix(4))
        guard !list.isEmpty else { return "No email account is signed in on this phone." }
        do {
            if name == "search_email" {
                let query = String(((input["query"] as? String) ?? "").replacingOccurrences(of: "\"", with: " ").prefix(120)).trimmingCharacters(in: .whitespaces)
                guard !query.isEmpty else { return "Nothing to search for." }
                var rows: [(Date, String)] = []
                var failed = ""
                for a in list {
                    guard let id = a["id"] else { continue }
                    do {
                        let json = try await get(id, "/me/messages", query: [URLQueryItem(name: "$search", value: "\"\(query)\""), URLQueryItem(name: "$top", value: "6"), URLQueryItem(name: "$select", value: "id,subject,from,receivedDateTime,bodyPreview")])
                        for m in (json["value"] as? [[String: Any]]) ?? [] {
                            guard let mid = m["id"] as? String else { continue }
                            let at = ISO8601DateFormatter().date(from: (m["receivedDateTime"] as? String) ?? "") ?? Date.distantPast
                            refs.append(["acc": id, "id": mid])
                            let preview = ((m["bodyPreview"] as? String) ?? "").components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
                            rows.append((at, "m\(refs.count) | From: \(who(m["from"])) | \(show(at, "EEE d MMM yyyy")) | \((m["subject"] as? String) ?? "(No subject)") | \(preview.prefix(200))"))
                        }
                    } catch let p as Problem { failed = p.text }
                }
                if rows.isEmpty { return failed.isEmpty ? "No email matches \u{201C}\(query)\u{201D}." : "The email could not be searched just now (\(failed))." }
                return rows.sorted { $0.0 > $1.0 }.prefix(8).map { $0.1 }.joined(separator: "\n")
            }
            if name == "read_email" {
                let digits = ((input["ref"] as? String) ?? "").filter { $0.isNumber }
                guard let n = Int(digits), n >= 1, n <= refs.count, let acc = refs[n - 1]["acc"], let mid = refs[n - 1]["id"] else { return "No email with that ref. Use a ref from search_email." }
                let m = try await get(acc, "/me/messages/" + mid, query: [URLQueryItem(name: "$select", value: "subject,from,toRecipients,receivedDateTime,body")], text: true)
                let at = ISO8601DateFormatter().date(from: (m["receivedDateTime"] as? String) ?? "") ?? Date()
                let to = ((m["toRecipients"] as? [Any]) ?? []).prefix(6).map { who($0) }.joined(separator: ", ")
                let body = (((m["body"] as? [String: Any])?["content"] as? String) ?? "").replacingOccurrences(of: "\r", with: "")
                return "From: \(who(m["from"]))\nTo: \(to)\nDate: \(show(at, "EEE d MMM yyyy, h:mm a"))\nSubject: \((m["subject"] as? String) ?? "")\n\n\(body.prefix(6000))"
            }
            if name == "calendar" {
                let day = DateFormatter(); day.locale = Locale(identifier: "en_US_POSIX"); day.dateFormat = "yyyy-MM-dd"
                let iso = ISO8601DateFormatter()
                let start = day.date(from: String(((input["from"] as? String) ?? "").prefix(10))) ?? Calendar.current.startOfDay(for: Date())
                var end = day.date(from: String(((input["to"] as? String) ?? "").prefix(10))) ?? start
                if end < start { end = start }
                if end.timeIntervalSince(start) > 45 * 86400 { end = start.addingTimeInterval(45 * 86400) }
                end = end.addingTimeInterval(86400)
                var rows: [(Date, String)] = []
                var failed = ""
                for a in list {
                    guard let id = a["id"] else { continue }
                    do {
                        let json = try await get(id, "/me/calendarView", query: [URLQueryItem(name: "startDateTime", value: iso.string(from: start)), URLQueryItem(name: "endDateTime", value: iso.string(from: end)),
                                                                                  URLQueryItem(name: "$select", value: "subject,start,end,location,isAllDay,isCancelled"), URLQueryItem(name: "$orderby", value: "start/dateTime"), URLQueryItem(name: "$top", value: "60")])
                        for e in (json["value"] as? [[String: Any]]) ?? [] {
                            if (e["isCancelled"] as? Bool) == true { continue }
                            let raw = ((e["start"] as? [String: Any])?["dateTime"] as? String) ?? ""
                            guard let from = utc(raw) else { continue }
                            let to = utc(((e["end"] as? [String: Any])?["dateTime"] as? String) ?? "") ?? from
                            let allDay = (e["isAllDay"] as? Bool) == true
                            let place = ((e["location"] as? [String: Any])?["displayName"] as? String) ?? ""
                            // (an all-day entry is given as midnight to midnight with no zone: its date is read as it stands)
                            let label: String
                            if allDay { let d = day.date(from: String(raw.prefix(10))) ?? from; label = "\(show(d, "EEE d MMM")), all day" }
                            else { label = "\(show(from, "EEE d MMM, h:mm a")) to \(show(to, "h:mm a"))" }
                            rows.append((from, "\(label) | \((e["subject"] as? String) ?? "(No title)")\(place.isEmpty ? "" : " | at " + place)"))
                        }
                    } catch let p as Problem { failed = p.text }
                }
                if rows.isEmpty { return failed.isEmpty ? "Nothing is in the calendar for those days." : "The calendar could not be read just now (\(failed)). Say it could not be checked." }
                return rows.sorted { $0.0 < $1.0 }.prefix(60).map { $0.1 }.joined(separator: "\n")
            }
        } catch let p as Problem { return "That could not be read just now (\(p.text))." } catch { return "That could not be read just now." }
        return "There is no such tool."
    }
}
