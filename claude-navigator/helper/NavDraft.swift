// navdraft: a small helper that lets Claude Navigator use the writing model built into the Mac
// (Apple Intelligence). Nothing leaves the Mac. It never sends email: it only returns words.
//
// It reads one JSON request per line and answers with JSON lines:
//   {"op":"status"}                                  ->  {"status":"ok"} or {"status":"no","reason":"..."}
//   {"op":"run","id":"a1","instructions":"...","prompt":"..."}
//                                                    ->  {"id":"a1","text":"the words so far"} (many times)
//                                                        {"id":"a1","done":true} or {"id":"a1","error":"..."}
//   {"op":"cancel","id":"a1"}
//   {"op":"listen","id":"m1","locale":"en-AU"}       ->  {"id":"m1","listening":true}
//                                                        {"id":"m1","heard":"everything heard so far"} (many times)
//                                                        {"id":"m1","heard":"...","listenDone":true} or {"id":"m1","error":"..."}
//   {"op":"stopListen","id":"m1"}
import Foundation
import AVFoundation
#if canImport(Speech)
import Speech
#endif
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

// Dictation with the Mac's newer speech engine: on the Mac itself, no chime, no bubble. Words are reported as they are heard.
@available(macOS 26.0, *)
final class Listener: @unchecked Sendable {
    let id: String
    let engine = AVAudioEngine()
    var feed: AsyncStream<AnalyzerInput>.Continuation?
    var analyzer: SpeechAnalyzer?
    var task: Task<Void, Never>?
    var stopped = false
    init(id: String) { self.id = id }

    func start(localeId: String, names: [String]) {
        let id = self.id
        task = Task {
            do {
                guard await AVCaptureDevice.requestAccess(for: .audio) else { emit(["id": id, "error": "microphone"]); return }
                let wanted = Locale(identifier: localeId)
                let supported = await SpeechTranscriber.supportedLocales
                let locale = supported.first(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) })
                    ?? supported.first(where: { $0.language.languageCode == wanted.language.languageCode })
                    ?? wanted
                let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    emit(["id": id, "note": "downloading"])
                    try await request.downloadAndInstall()
                }
                let analyzer = SpeechAnalyzer(modules: [transcriber])
                self.analyzer = analyzer
                guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { emit(["id": id, "error": "no audio format"]); return }
                let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
                self.feed = cont
                let input = engine.inputNode
                let inFormat = input.outputFormat(forBus: 0)
                guard let converter = AVAudioConverter(from: inFormat, to: format) else { emit(["id": id, "error": "no converter"]); return }
                let ratio = format.sampleRate / inFormat.sampleRate
                input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buf, _ in
                    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * ratio) + 32) else { return }
                    var given = false
                    var err: NSError?
                    converter.convert(to: out, error: &err) { _, status in
                        if given { status.pointee = .noDataNow; return nil }
                        given = true; status.pointee = .haveData; return buf
                    }
                    if err == nil, out.frameLength > 0 { cont.yield(AnalyzerInput(buffer: out)) }
                }
                engine.prepare()
                try engine.start()
                if !names.isEmpty {          // names it should know: your staff, companies and the people you write to
                    let context = AnalysisContext()
                    context.contextualStrings[.general] = names
                    try await analyzer.setContext(context)
                }
                try await analyzer.start(inputSequence: stream)
                if self.stopped { self.stop() }
                emit(["id": id, "listening": true])
                var done = ""
                for try await r in transcriber.results {
                    let t = String(r.text.characters)
                    if r.isFinal { done += t; emit(["id": id, "heard": done]) } else { emit(["id": id, "heard": done + t]) }
                }
                emit(["id": id, "heard": done, "listenDone": true])
            } catch {
                self.engine.stop()
                emit(["id": id, "error": String(describing: error)])
            }
        }
    }
    func stop() {
        stopped = true
        guard let analyzer = analyzer else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        feed?.finish()
        Task { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
    }
}

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
        var listeners: [String: AnyObject] = [:]
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
            if op == "listen" {
                if #available(macOS 26.0, *) {
                    for (_, l) in listeners { (l as? Listener)?.stop() }
                    let l = Listener(id: id); listeners = [id: l]
                    l.start(localeId: o["locale"] as? String ?? "en-AU", names: (o["names"] as? [String]) ?? [])
                } else { emit(["id": id, "error": "macOS is too old"]) }
                continue
            }
            if op == "stopListen" {
                if #available(macOS 26.0, *) { (listeners[id] as? Listener)?.stop() }
                listeners[id] = nil
                continue
            }
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
