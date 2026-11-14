// The voice Drive mode speaks with: the phone's own voice, using the most natural one installed.
// It is free and works with no signal. Nothing is sent to any outside service.

import Foundation
import AVFoundation

final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    var onFinished: (() -> Void)?            // called once for each piece handed to say()
    private let phone = AVSpeechSynthesizer()
    private var queue: [String] = []
    private var busy = false

    override init() { super.init(); phone.delegate = self }

    // The most natural voice installed on the phone, Australian first.
    private func bestPhoneVoice() -> AVSpeechSynthesisVoice? {
        let all = AVSpeechSynthesisVoice.speechVoices()
        for language in ["en-AU", "en-GB", "en-US"] {
            let mine = all.filter { $0.language == language }.sorted { $0.quality.rawValue > $1.quality.rawValue }
            if let first = mine.first { return first }
        }
        return AVSpeechSynthesisVoice(language: "en-AU")
    }

    var phoneVoiceNote: String {
        guard let voice = bestPhoneVoice() else { return "" }
        let level = voice.quality.rawValue >= 3 ? "Premium" : voice.quality.rawValue == 2 ? "Enhanced" : "Standard"
        return "\(voice.name), \(level)"
    }

    // MARK: Speaking, one piece after another

    func say(_ text: String) {
        queue.append(text)
        next()
    }

    func stop() {
        queue.removeAll()
        busy = false
        phone.stopSpeaking(at: .immediate)
    }

    private func next() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let text = queue.removeFirst()
        speakOnPhone(text)
    }

    private func finished() {
        busy = false
        onFinished?()
        next()
    }

    private func speakOnPhone(_ text: String) {
        let words = AVSpeechUtterance(string: text)
        words.voice = bestPhoneVoice()
        words.rate = AVSpeechUtteranceDefaultSpeechRate
        phone.speak(words)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finished() }
}
