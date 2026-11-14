// Hearing with the iPhone's newer speech engine (iOS 26 and later): quicker and more accurate, on the phone itself.
// Drive falls back to the older engine whenever this one is not ready or has a problem.

import Foundation
import AVFoundation
import Speech

@available(iOS 26.0, *)
final class NewHearing: @unchecked Sendable {
    nonisolated(unsafe) static var locale: Locale?
    nonisolated(unsafe) static var format: AVAudioFormat?
    nonisolated(unsafe) static var ready = false
    nonisolated(unsafe) static var failed = false

    // Done once, ahead of time: find Australian English and make sure the phone has what it needs for it.
    static func prepare() {
        Task {
            do {
                let wanted = Locale(identifier: "en-AU")
                let supported = await SpeechTranscriber.supportedLocales
                guard let found = supported.first(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) })
                        ?? supported.first(where: { $0.language.languageCode == wanted.language.languageCode }) else { return }
                let transcriber = SpeechTranscriber(locale: found, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
                guard let best = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { return }
                locale = found; format = best; ready = true
            } catch { /* the older engine is used */ }
        }
    }

    private var feedTo: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzer: SpeechAnalyzer?
    private var converter: AVAudioConverter?
    private var target: AVAudioFormat?
    private var ratio = 1.0
    private var over = false

    // Returns false if it cannot start (the caller then uses the older engine).
    func start(from inFormat: AVAudioFormat, names: [String], onText: @escaping (String) -> Void, onProblem: @escaping () -> Void) -> Bool {
        guard NewHearing.ready, !NewHearing.failed, let locale = NewHearing.locale, let format = NewHearing.format,
              let conv = AVAudioConverter(from: inFormat, to: format) else { return false }
        converter = conv; target = format; ratio = format.sampleRate / inFormat.sampleRate
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
        feedTo = cont
        Task {
            do {
                if !names.isEmpty {          // names it should know: your staff and companies
                    let context = AnalysisContext()
                    context.contextualStrings[.general] = names
                    try await analyzer.setContext(context)
                }
                try await analyzer.start(inputSequence: stream)
                var done = ""
                for try await result in transcriber.results {
                    if self.over { break }
                    let text = String(result.text.characters)
                    if result.isFinal { done += text; onText(done) } else { onText(done + text) }
                }
            } catch {
                if !self.over { NewHearing.failed = true; onProblem() }
            }
        }
        return true
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard !over, let converter = converter, let target = target,
              let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32) else { return }
        var given = false
        var problem: NSError?
        converter.convert(to: out, error: &problem) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true; status.pointee = .haveData; return buffer
        }
        if problem == nil, out.frameLength > 0 { feedTo?.yield(AnalyzerInput(buffer: out)) }
    }

    func finish() {
        over = true
        feedTo?.finish()
        let analyzer = self.analyzer
        Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
    }
}
