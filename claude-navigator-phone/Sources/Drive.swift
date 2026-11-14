// Drive mode: your voice in, a spoken answer out.
// Hearing uses the phone's own speech recognition; speaking uses the phone's own voice. Claude is asked through the
// same signed-in Claude page the rest of the app uses, so there is no extra account and no extra cost.

import Foundation
import AVFoundation
import Speech
import WebKit
import UIKit

final class Drive: NSObject {
    private let ui: WKWebView
    private let claude: WKWebView
    private let engine = AVAudioEngine()
    private let recogniser = SFSpeechRecognizer(locale: Locale(identifier: "en-AU")) ?? SFSpeechRecognizer()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    let voice = Voice()
    private var heard = ""
    private var quietTimer: Timer?
    private var giveUpTimer: Timer?
    private var answerTimer: Timer?
    private var listening = false
    private var askID = 0

    init(ui: WKWebView, claude: WKWebView) {
        self.ui = ui
        self.claude = claude
        super.init()
        voice.onFinished = { [weak self] in self?.tell("driveSpoke", [:]) }
    }

    private func tell(_ function: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let text = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.ui.evaluateJavaScript("window.\(function) && window.\(function)(\(text))", completionHandler: nil) }
    }

    func setAwake(_ on: Bool) { DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on } }

    private func audio() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .duckOthers])
        try? session.setActive(true, options: [])
    }

    // MARK: Hearing

    func listen(wait: Double) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else { return self.tell("driveHeard", ["text": "", "final": true, "problem": "Allow Speech Recognition for Chief of Staff in Settings."]) }
            AVAudioSession.sharedInstance().requestRecordPermission { ok in
                guard ok else { return self.tell("driveHeard", ["text": "", "final": true, "problem": "Allow the microphone for Chief of Staff in Settings."]) }
                DispatchQueue.main.async { self.startListening(wait: wait) }
            }
        }
    }

    private func startListening(wait: Double) {
        stopListening(send: false)
        voice.stop()
        guard let recogniser = recogniser, recogniser.isAvailable else { return tell("driveHeard", ["text": "", "final": true, "problem": "Speech recognition is not available right now."]) }
        audio()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request
        heard = ""
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return tell("driveHeard", ["text": "", "final": true, "problem": "The microphone is not ready."]) }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        engine.prepare()
        do { try engine.start() } catch { return tell("driveHeard", ["text": "", "final": true, "problem": "The microphone could not start."]) }
        listening = true
        task = recogniser.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self, self.listening else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                if text != self.heard {
                    self.heard = text
                    self.tell("driveHeard", ["text": text, "final": false])
                    DispatchQueue.main.async {      // a pause of a second and a half means you have finished
                        self.quietTimer?.invalidate()
                        self.quietTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { _ in self.stopListening(send: true) }
                    }
                }
            }
            if error != nil { DispatchQueue.main.async { self.stopListening(send: true) } }
        }
        giveUpTimer?.invalidate()          // nothing said at all: stop waiting
        giveUpTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            guard let self = self, self.heard.isEmpty else { return }
            self.stopListening(send: true)
        }
    }

    func stopListening(send: Bool) {
        quietTimer?.invalidate(); quietTimer = nil
        giveUpTimer?.invalidate(); giveUpTimer = nil
        let was = listening
        listening = false
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio(); request = nil
        task?.cancel(); task = nil
        if send && was { tell("driveHeard", ["text": heard, "final": true]) }
    }

    // MARK: Speaking

    func say(_ text: String) {
        stopListening(send: false)
        audio()
        voice.say(text)          // pieces are spoken one after another, in order
    }

    // Opens Claude ahead of the first question, so the page is ready when you speak.
    func warm(url: URL) { if !same(claude.url, url) { claude.load(URLRequest(url: url)) } }

    func hush() {
        askID += 1
        answerTimer?.invalidate(); answerTimer = nil
        stopListening(send: false)
        voice.stop()
    }

    // MARK: Asking Claude

    // Puts the words into Claude's message box and sends them. Returns "sent", "none" (no box yet) or "empty".
    private func sendScript(_ text: String) -> String {
        let words = (try? JSONSerialization.data(withJSONObject: [text])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return """
        (async () => {
          const words = \(words)[0];
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          for (let i = 0; i < 24; i++) {
            const box = document.querySelector('[contenteditable="true"].ProseMirror, div[contenteditable="true"], textarea');
            if (box) {
              box.focus();
              const has = () => (box.innerText || box.value || '').trim();
              if (!has()) document.execCommand('insertText', false, words);
              if (!has()) { try { const dt = new DataTransfer(); dt.setData('text/plain', words); box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } catch (e) {} await sleep(250); }
              if (!has() && 'value' in box) { box.value = words; box.dispatchEvent(new Event('input', { bubbles: true })); }
              if (!has()) return 'empty';
              for (let j = 0; j < 12; j++) {
                await sleep(250);
                const send = [...document.querySelectorAll('button')].find(b => /send/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')) && !b.disabled);
                if (send) { send.click(); return 'sent'; }
              }
              box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
              return 'sent';
            }
            await sleep(250);
          }
          return 'none';
        })()
        """
    }

    private func same(_ a: URL?, _ b: URL) -> Bool {
        guard let a = a else { return false }
        return a.host == b.host && a.path == b.path
    }

    func ask(url: URL, prompt: String, nonce: String) {
        askID += 1
        let mine = askID
        answerTimer?.invalidate()
        if !same(claude.url, url) { claude.load(URLRequest(url: url)) }
        var tries = 0
        func trySend() {
            guard mine == self.askID else { return }
            tries += 1
            claude.callAsyncJavaScript("return await \(sendScript(prompt))", arguments: [:], in: nil, in: .page) { result in
                guard mine == self.askID else { return }
                let outcome = (try? result.get()) as? String ?? "none"
                if outcome == "sent" { self.watch(nonce: nonce, id: mine) }
                else if tries < 8 { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { trySend() } }
                else { self.tell("driveAnswer", ["text": "", "done": true, "problem": outcome == "none" ? "Claude did not open. Check you are signed in." : "Claude did not take the question."]) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { trySend() }
    }

    // Reads Claude's page until the spoken answer (between [[SAY]] and [[END]]) is complete.
    private func watch(nonce: String, id: Int) {
        let key = (try? JSONSerialization.data(withJSONObject: [nonce])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        let read = "(() => { const k = \(key)[0], t = document.body ? document.body.innerText : ''; const i = t.lastIndexOf(k); return i < 0 ? '' : t.slice(i + k.length); })()"
        var ticks = 0
        var last = ""
        var steady = 0
        answerTimer?.invalidate()
        answerTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self = self, id == self.askID else { timer.invalidate(); return }
            ticks += 1
            if ticks > 240 { timer.invalidate(); return self.tell("driveAnswer", ["text": "", "done": true, "problem": "Claude has not answered yet. The question is in the chat."]) }
            self.claude.evaluateJavaScript(read) { value, _ in
                guard id == self.askID, let after = value as? String, let start = after.range(of: "[[SAY]]") else { return }
                let rest = String(after[start.upperBound...])
                let address = self.claude.url?.absoluteString ?? ""
                if let end = rest.range(of: "[[END]]") {
                    timer.invalidate()
                    self.tell("driveAnswer", ["text": String(rest[..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines), "done": true, "url": address])
                } else {
                    let now = rest.trimmingCharacters(in: .whitespacesAndNewlines)
                    if now != last && !now.isEmpty { self.tell("driveAnswer", ["text": now, "done": false, "url": address]) }      // what has arrived so far
                    steady = now == last ? steady + 1 : 0
                    last = now
                    if steady >= 15 && !now.isEmpty {       // it stopped without the closing mark: take what is there
                        timer.invalidate()
                        self.tell("driveAnswer", ["text": now, "done": true, "url": address])
                    }
                }
            }
        }
    }
}
