// Simple questions answered on the phone itself, by the model built into the iPhone (Apple Intelligence).
// Nothing leaves the phone, and the answer comes in about a second. Anything that needs real thinking still goes to Claude.

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

final class Local {
    var tell: ((String, [String: Any]) -> Void)?
    private var task: Task<Void, Never>?

    var ready: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    // Loads the model ahead of the first question.
    func warm() {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *), ready { LanguageModelSession().prewarm() }
        #endif
    }

    func cancel() { task?.cancel(); task = nil }

    func answer(id: String, instructions: String, prompt: String) {
        cancel()
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let tell = self.tell
            task = Task {
                do {
                    let session = LanguageModelSession(instructions: instructions)
                    let reply = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.2, maximumResponseTokens: 220))
                    if Task.isCancelled { return }
                    tell?("driveLocalAnswer", ["id": id, "text": reply.content])
                } catch {
                    if Task.isCancelled { return }
                    tell?("driveLocalAnswer", ["id": id, "error": String(describing: error)])
                }
            }
            return
        }
        #endif
        tell?("driveLocalAnswer", ["id": id, "error": "not available"])
    }
}
