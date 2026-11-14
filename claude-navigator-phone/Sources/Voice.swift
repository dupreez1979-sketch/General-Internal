// The voice Drive mode speaks with.
// Two choices: the phone's own voice (free, works with no signal; the best one installed is used), or an ElevenLabs
// voice (more natural; uses your ElevenLabs account, which charges for what is spoken). The ElevenLabs key is typed
// into the app and kept in the phone's Keychain. It is never written to a file or sent anywhere but ElevenLabs.

import Foundation
import AVFoundation
import Security

final class Voice: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    var onFinished: (() -> Void)?            // called once for each piece handed to say()
    private let phone = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var queue: [String] = []
    private var busy = false
    private var generation = 0
    private let service = "com.dupreez.claude-navigator-phone.elevenlabs"

    override init() { super.init(); phone.delegate = self }

    // MARK: Settings

    var mode: String { get { UserDefaults.standard.string(forKey: "voiceMode") ?? "phone" } set { UserDefaults.standard.set(newValue, forKey: "voiceMode") } }
    var voiceID: String { get { UserDefaults.standard.string(forKey: "voiceID") ?? "" } set { UserDefaults.standard.set(newValue, forKey: "voiceID") } }
    var voiceName: String { get { UserDefaults.standard.string(forKey: "voiceName") ?? "" } set { UserDefaults.standard.set(newValue, forKey: "voiceName") } }

    var key: String? {
        get {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
            SecItemDelete(base as CFDictionary)
            guard let value = newValue, !value.isEmpty, let data = value.data(using: .utf8) else { return }
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }

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
        generation += 1
        queue.removeAll()
        busy = false
        phone.stopSpeaking(at: .immediate)
        player?.stop(); player = nil
    }

    private func next() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let text = queue.removeFirst()
        let mine = generation
        if mode == "eleven", let key = key, !voiceID.isEmpty { eleven(text, key: key, id: mine) } else { speakOnPhone(text) }
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

    private func eleven(_ text: String, key: String, id: Int) {
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceID)?output_format=mp3_44100_128") else { return speakOnPhone(text) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text, "model_id": "eleven_flash_v2_5"])
        URLSession.shared.dataTask(with: request) { data, response, _ in
            DispatchQueue.main.async {
                guard id == self.generation else { return }
                let ok = (response as? HTTPURLResponse)?.statusCode == 200
                if ok, let data = data, let player = try? AVAudioPlayer(data: data) {
                    self.player = player
                    player.delegate = self
                    if player.play() { return }
                }
                self.speakOnPhone(text)          // no signal, no credit or a wrong key: the phone's own voice says it instead
            }
        }.resume()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { finished() }

    // The voices in your ElevenLabs account, to choose from.
    func listVoices(key: String, done: @escaping ([[String: String]], String) -> Void) {
        guard let url = URL(string: "https://api.elevenlabs.io/v1/voices") else { return done([], "Could not reach ElevenLabs.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            DispatchQueue.main.async {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200, let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let voices = json["voices"] as? [[String: Any]] else {
                    return done([], status == 401 ? "ElevenLabs did not accept that key." : "Could not read your ElevenLabs voices.")
                }
                let list: [[String: String]] = voices.compactMap { v in
                    guard let id = v["voice_id"] as? String, let name = v["name"] as? String else { return nil }
                    let labels = v["labels"] as? [String: Any]
                    let note = [labels?["accent"] as? String, labels?["gender"] as? String, labels?["description"] as? String].compactMap { $0 }.joined(separator: ", ")
                    return ["id": id, "name": name, "note": note]
                }
                done(list, list.isEmpty ? "No voices found in your ElevenLabs account." : "")
            }
        }.resume()
    }
}
