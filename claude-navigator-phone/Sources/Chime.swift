// The small sounds Drive makes: it starts listening, it has heard you, it is still working, an answer is ready,
// something was made, something did not work. They are made here from plain tones (low, warm and short),
// so there are no sound files and nothing to pay for.

import Foundation
import AVFoundation

final class Chime {
    private var players: [String: AVAudioPlayer] = [:]

    // Each note: pitch in hertz, when it starts (seconds), how long it rings (seconds).
    private static let tunes: [String: [[Double]]] = [
        "listen": [[196.0, 0.0, 0.28], [293.7, 0.11, 0.36]],
        "heard": [[293.7, 0.0, 0.24], [196.0, 0.11, 0.36]],
        "working": [[261.6, 0.0, 0.42]],
        "ready": [[261.6, 0.0, 0.26], [329.6, 0.1, 0.26], [392.0, 0.2, 0.5]],
        "made": [[261.6, 0.0, 0.6], [392.0, 0.02, 0.6], [523.3, 0.14, 0.7]],
        "no": [[220.0, 0.0, 0.22], [220.0, 0.16, 0.34]],
    ]

    init() {
        for (name, notes) in Chime.tunes {
            if let player = try? AVAudioPlayer(data: Chime.wav(notes)) { player.prepareToPlay(); players[name] = player }
        }
    }

    func play(_ name: String) {
        guard let player = players[name] else { return }
        player.currentTime = 0
        player.play()
    }

    private static func wav(_ notes: [[Double]]) -> Data {
        let rate: Double = 44100
        var longest: Double = 0.3
        for note in notes where note.count == 3 { longest = max(longest, note[1] + note[2]) }
        let count = Int((longest + 0.3) * rate)
        var wave = [Double](repeating: 0, count: count)
        for note in notes where note.count == 3 {
            let pitch: Double = note[0], length: Double = note[2]
            let first = Int(note[1] * rate), total = Int(length * rate)
            for i in 0..<total {
                let at = first + i
                if at >= count { break }
                let t: Double = Double(i) / rate
                let swell: Double = t < 0.012 ? t / 0.012 : exp(-6.5 * (t - 0.012) / length)
                let turn: Double = 2.0 * Double.pi * pitch * t
                let body: Double = sin(turn)
                let shine: Double = 0.14 * sin(4.0 * turn)
                let wood: Double = 0.1 * (2.0 / Double.pi) * asin(sin(2.0 * turn))
                wave[at] += 0.3 * swell * (body + shine + wood)
            }
        }
        // a little room: one quiet echo
        let echo = Int(0.11 * rate)
        if count > echo { for i in stride(from: count - 1, through: echo, by: -1) { wave[i] += 0.16 * wave[i - echo] } }

        var data = Data()
        func put32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func put16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        let bytes = UInt32(count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put32(36 + bytes); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); put32(16); put16(1); put16(1); put32(44100); put32(88200); put16(2); put16(16)
        data.append(contentsOf: Array("data".utf8)); put32(bytes)
        for sample in wave {
            let clipped: Double = max(-1.0, min(1.0, sample))
            put16(UInt16(bitPattern: Int16(clipped * 32000.0)))
        }
        return data
    }
}
