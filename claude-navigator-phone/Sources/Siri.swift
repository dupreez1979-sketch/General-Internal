// "Hey Siri, talk to my Chief of Staff": opens the app in Drive mode, already listening, so you never touch the phone.

import AppIntents
import Foundation

extension Notification.Name { static let startDrive = Notification.Name("startDrive") }

struct TalkToChiefOfStaff: AppIntent {
    static let title: LocalizedStringResource = "Talk to my Chief of Staff"
    static let description = IntentDescription("Opens Drive mode and starts listening.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "startDriveAt")
        NotificationCenter.default.post(name: .startDrive, object: nil)
        return .result()
    }
}

struct ChiefShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TalkToChiefOfStaff(),
                    phrases: ["Talk to my \(.applicationName)", "Start Drive in \(.applicationName)", "Ask my \(.applicationName)"],
                    shortTitle: "Talk to my Chief of Staff", systemImageName: "mic.fill")
    }
}
