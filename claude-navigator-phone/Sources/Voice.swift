// The voice Drive mode speaks with: the phone's own voice, using the most natural one installed.
// It is free and works with no signal. Nothing is sent to any outside service.

import Foundation
import AVFoundation

final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    var onFinished: (() -> Void)?            // called once for each piece handed to say()
    private let phone = AVSpeechSynthesizer()
    private var queue: [String] = []
    private var busy = false
    var hasMore: Bool { !queue.isEmpty }      // more pieces are waiting to be spoken

    override init() { super.init(); phone.delegate = self }

    // The voice to use: the one you chose in the Voice sheet, or else the most natural English voice installed
    // (Premium before Enhanced before the basic one; Australian first among equals).
    private let chosenKey = "phoneVoiceChosen"
    private func level(_ voice: AVSpeechSynthesisVoice) -> Int { voice.quality.rawValue }
    private func place(_ language: String) -> Int { language == "en-AU" ? 0 : language == "en-GB" ? 1 : language == "en-US" ? 2 : 3 }

    var englishVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en") }
            .sorted { level($0) != level($1) ? level($0) > level($1) : place($0.language) != place($1.language) ? place($0.language) < place($1.language) : $0.name < $1.name }
    }

    var chosenID: String {
        get { UserDefaults.standard.string(forKey: chosenKey) ?? "" }
        set { if newValue.isEmpty { UserDefaults.standard.removeObject(forKey: chosenKey) } else { UserDefaults.standard.set(newValue, forKey: chosenKey) } }
    }

    private func bestPhoneVoice() -> AVSpeechSynthesisVoice? {
        if !chosenID.isEmpty, let mine = AVSpeechSynthesisVoice(identifier: chosenID) { return mine }
        return englishVoices.first ?? AVSpeechSynthesisVoice(language: "en-AU")
    }

    private func label(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality = level(voice) >= 3 ? "Premium" : level(voice) == 2 ? "Enhanced" : "Basic"
        let where_ = voice.language == "en-AU" ? "Australian" : voice.language == "en-GB" ? "British" : voice.language == "en-US" ? "American" : voice.language
        return "\(quality), \(where_)"
    }

    var phoneVoiceNote: String {
        guard let voice = bestPhoneVoice() else { return "" }
        return "\(voice.name) (\(label(voice)))"
    }

    // Every English voice on the phone, best first, for the Voice sheet.
    var voiceList: [[String: Any]] {
        let current = bestPhoneVoice()?.identifier ?? ""
        return englishVoices.prefix(40).map { ["id": $0.identifier, "name": $0.name, "note": label($0), "on": $0.identifier == current] }
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
