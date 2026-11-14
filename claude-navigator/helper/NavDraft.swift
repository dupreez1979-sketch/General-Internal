// navdraft: a small helper that lets Claude Navigator use the writing model built into the Mac
// (Apple Intelligence). Nothing leaves the Mac. It never sends email: it only returns words.
//
// It reads one JSON request per line and answers with JSON lines:
//   {"op":"status"}                                  ->  {"status":"ok"} or {"status":"no","reason":"..."}
//   {"op":"run","id":"a1","instructions":"...","prompt":"..."}
//                                                    ->  {"id":"a1","text":"the words so far"} (many times)
//                                                        {"id":"a1","done":true} or {"id":"a1","error":"..."}
//   {"op":"cancel","id":"a1"}
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

let outLock = NSLock()
func emit(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o), var s = String(data: d, encoding: .utf8) else { return }
    s += "\n"
    outLock.lock(); FileHandle.standardOutput.write(s.data(using: .utf8)!); outLock.unlock()
}

func statusNow() -> [String: Any] {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available: return ["status": "ok"]
        case .unavailable(let why): return ["status": "no", "reason": String(describing: why)]
        @unknown default: return ["status": "no", "reason": "unknown"]
        }
    }
    return ["status": "no", "reason": "macOS is too old"]
    #else
    return ["status": "no", "reason": "built without the model"]
    #endif
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
func write(id: String, instructions: String, prompt: String) async {
    do {
        let session = LanguageModelSession(instructions: instructions)
        let stream = session.streamResponse(to: prompt, options: GenerationOptions(temperature: 0.4, maximumResponseTokens: 700))
        for try await part in stream {
            if Task.isCancelled { return }
            emit(["id": id, "text": part.content])
        }
        emit(["id": id, "done": true])
    } catch {
        if Task.isCancelled { return }
        emit(["id": id, "error": String(describing: error)])
    }
}
#endif

@main
struct NavDraft {
    static func main() async {
        if CommandLine.arguments.contains("--sdk") {
            #if canImport(FoundationModels)
            print("model:yes")
            #else
            print("model:no")
            #endif
            return
        }
        var running: [String: Task<Void, Never>] = [:]
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            LanguageModelSession().prewarm()          // load the model now, so the first draft starts at once
        }
        #endif
        while let line = readLine(strippingNewline: true) {
            guard let d = line.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            let op = o["op"] as? String ?? "", id = o["id"] as? String ?? ""
            if op == "status" { emit(statusNow()); continue }
            if op == "cancel" { running[id]?.cancel(); running[id] = nil; continue }
            if op == "run" {
                let ins = o["instructions"] as? String ?? "", prompt = o["prompt"] as? String ?? ""
                #if canImport(FoundationModels)
                if #available(macOS 26.0, *) {
                    running[id]?.cancel()
                    running[id] = Task { await write(id: id, instructions: ins, prompt: prompt) }
                    continue
                }
                #endif
                emit(["id": id, "error": "The Mac's writing model is not available."])
            }
        }
    }
}
