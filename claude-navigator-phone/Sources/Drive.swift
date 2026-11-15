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
    let local = Local()
    let chimes = Chime()
    private var sayAfter = Date.distantPast       // speech waits for a sound that has just started
    private var hushes = 0
    var bargeIn = true                       // you can interrupt a spoken answer by speaking
    private var monitoring = false           // listening while the phone is speaking, only for an interruption
    private var spoken = Set<String>()       // the words the phone has said this turn (so it does not hear itself as you)
    private var skipWords = 0
    var pause: Double = 4.0                  // how long a silence ends your turn (0: only when you press Done talking)
    private let endWords = ["over", "that's all", "that is all", "thats all", "done talking"]
    var names: [String] = []                 // names the hearing should know: your staff and companies
    private var newHearing: AnyObject?       // the newer speech engine, when the phone has it
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
        if #available(iOS 26.0, *) { NewHearing.prepare() }
        local.tell = { [weak self] function, payload in self?.tell(function, payload) }
        voice.onFinished = { [weak self] in
            guard let self = self else { return }
            if self.monitoring && !self.voice.hasMore { self.stopListening(send: false) }
            self.tell("driveSpoke", [:])
        }
    }

    func tell(_ function: String, _ payload: [String: Any]) {
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

    private func norm(_ word: Substring) -> String { String(word).lowercased().filter { $0.isLetter || $0.isNumber } }

    // While the phone is speaking: where in what was heard you started talking over it, if you did.
    // A clear "stop" or "wait" counts at once; otherwise three words in a row that the phone did not say.
    private func interruptionStart(_ tokens: [Substring]) -> Int? {
        let w = tokens.map { norm($0) }
        let cues: Set<String> = ["stop", "wait", "pause", "cancel", "enough"]
        if let i = w.indices.suffix(2).first(where: { cues.contains(w[$0]) && !spoken.contains(w[$0]) }) { return i }
        var run = 0, first = w.count
        for i in w.indices.reversed() {
            if w[i].count < 3 { continue }
            if spoken.contains(w[i]) { break }
            run += 1; first = i
        }
        return run >= 3 ? first : nil
    }

    // If what was heard finishes with an end word after other words, the text without it; otherwise nil.
    private func endsWithEndWord(_ text: String) -> String? {
        let low = text.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " .,!?"))
        for word in endWords where low.hasSuffix(" " + word) {
            let kept = String(text.trimmingCharacters(in: CharacterSet(charactersIn: " .,!?")).dropLast(word.count)).trimmingCharacters(in: CharacterSet(charactersIn: " .,!?"))
            if kept.split(separator: " ").count >= 2 { return kept }
        }
        return nil
    }

    // What has been heard so far, from either engine.
    private func heardNow(_ full: String) {
        let tokens = full.split(separator: " ")
        if monitoring {
            guard let at = interruptionStart(tokens) else { return }
            monitoring = false          // you spoke: stop talking and listen to you
            skipWords = at
            askID += 1
            DispatchQueue.main.async { self.answerTimer?.invalidate(); self.answerTimer = nil; self.voice.stop(); self.local.cancel() }
            tell("driveInterrupted", [:])
        }
        let text = tokens.dropFirst(skipWords).joined(separator: " ")
        guard text != heard else { return }
        heard = text
        tell("driveHeard", ["text": text, "final": false])
        // Your turn ends after a real pause (you choose how long), or sooner if you finish with "over" or "that's all".
        let ended = endsWithEndWord(text) != nil
        let wait = ended ? 0.9 : pause
        DispatchQueue.main.async {
            self.quietTimer?.invalidate(); self.quietTimer = nil
            guard wait > 0 else { return }
            self.quietTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { _ in self.stopListening(send: true) }
        }
    }

    private func startListening(wait: Double, monitor: Bool = false) {
        stopListening(send: false)
        if !monitor { voice.stop(); spoken.removeAll() }
        guard let recogniser = recogniser, recogniser.isAvailable else { if monitor { return }; return tell("driveHeard", ["text": "", "final": true, "problem": "Speech recognition is not available right now."]) }
        monitoring = monitor
        skipWords = 0
        audio()
        heard = ""
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { if monitor { monitoring = false; return }; return tell("driveHeard", ["text": "", "final": true, "problem": "The microphone is not ready."]) }
        input.removeTap(onBus: 0)
        var feed: ((AVAudioPCMBuffer) -> Void)?
        if #available(iOS 26.0, *) {          // the newer engine first
            let hearing = NewHearing()
            let started = hearing.start(from: format, names: names, onText: { [weak self] text in
                guard let self = self, self.listening, self.newHearing === hearing else { return }
                self.heardNow(text)
            }, onProblem: { [weak self] in
                DispatchQueue.main.async { guard let self = self, self.newHearing === hearing else { return }; self.stopListening(send: !self.monitoring) }
            })
            if started { newHearing = hearing; feed = { hearing.feed($0) } }
        }
        if feed == nil {                      // the older engine
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if !names.isEmpty { request.contextualStrings = names }
            self.request = request
            feed = { request.append($0) }
            task = recogniser.recognitionTask(with: request) { [weak self] result, error in
                guard let self = self, self.listening else { return }
                if let result = result { self.heardNow(result.bestTranscription.formattedString) }
                if error != nil { DispatchQueue.main.async { self.stopListening(send: !self.monitoring) } }
            }
        }
        let give = feed!
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in give(buffer) }
        engine.prepare()
        do { try engine.start() } catch { let quiet = monitor; stopListening(send: false); if quiet { return }; return tell("driveHeard", ["text": "", "final": true, "problem": "The microphone could not start."]) }
        listening = true
        giveUpTimer?.invalidate()          // nothing said at all: stop waiting
        if monitor { return }
        giveUpTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            guard let self = self, self.heard.isEmpty else { return }
            self.stopListening(send: true)
        }
    }

    func stopListening(send: Bool) {
        quietTimer?.invalidate(); quietTimer = nil
        giveUpTimer?.invalidate(); giveUpTimer = nil
        let was = listening && !monitoring
        listening = false
        monitoring = false
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio(); request = nil
        if #available(iOS 26.0, *) { (newHearing as? NewHearing)?.finish() }
        newHearing = nil
        task?.cancel(); task = nil
        if send && was { tell("driveHeard", ["text": endsWithEndWord(heard) ?? heard, "final": true]) }
    }

    // MARK: Speaking

    func say(_ text: String) {
        if !(listening && monitoring) { stopListening(send: false) }
        audio()
        for word in text.split(separator: " ") { spoken.insert(norm(word)) }
        if bargeIn && !listening && SFSpeechRecognizer.authorizationStatus() == .authorized && AVAudioSession.sharedInstance().recordPermission == .granted {
            startListening(wait: 0, monitor: true)          // so you can interrupt by speaking
        }
        let wait = sayAfter.timeIntervalSinceNow
        if wait > 0 {
            let mine = hushes
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { if mine == self.hushes { self.voice.say(text) } }
        } else {
            voice.say(text)          // pieces are spoken one after another, in order
        }
    }

    // A short sound for what just happened. Anything spoken straight after waits for it.
    func chime(_ name: String) {
        audio()
        chimes.play(name)
        sayAfter = Date().addingTimeInterval(name == "ready" || name == "made" ? 0.6 : 0.45)
    }

    // Opens Claude ahead of the first question, so the page is ready when you speak.
    func warm(url: URL) { if !same(claude.url, url) { claude.load(URLRequest(url: url)) } }

    func hush() {
        askID += 1
        hushes += 1
        sayAfter = Date.distantPast
        answerTimer?.invalidate(); answerTimer = nil
        stopListening(send: false)
        voice.stop()
        local.cancel()
    }

    // MARK: Claude's model while driving

    // Claude answers with whichever model was used last, and the larger ones think before they speak. For a drive the
    // app chooses the fastest model in Claude's own model menu, remembers which one was there, and puts it back when
    // you finish. It works by pressing Claude's menu, so it checks the result and says so if it could not.
    private let modelKey = "driveModelWas"

    private func modelScript(want: String) -> String {
        let pattern = (try? JSONSerialization.data(withJSONObject: [want])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"haiku\"]"
        return """
        (async () => {
          const want = new RegExp(\(pattern)[0], 'i');
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const seen = e => e && e.getClientRects().length > 0;
          const names = /\\b(Opus|Sonnet|Haiku|Fable|Mythos)\\b/i;
          const picker = () => { const all = [...document.querySelectorAll('button')].filter(b => seen(b) && names.test(b.innerText || '') && (b.innerText || '').trim().length < 40); return all.find(b => b.getAttribute('aria-haspopup')) || all[all.length - 1] || null; };
          let p = null;
          for (let i = 0; i < 40 && !p; i++) { p = picker(); if (!p) await sleep(300); }
          if (!p) return { ok: false, why: 'no model menu', was: '', now: '' };
          const was = (p.innerText || '').replace(/\\s+/g, ' ').trim();
          if (want.test(was)) return { ok: true, was, now: was };
          const items = () => [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="menu"] button, [role="listbox"] button, [role="dialog"] button')].filter(seen);
          p.click(); await sleep(500);
          let hit = items().find(i => want.test(i.innerText || ''));
          if (!hit) { const more = items().find(i => /more models|other models|all models/i.test(i.innerText || '')); if (more) { more.click(); await sleep(500); hit = items().find(i => want.test(i.innerText || '')); } }
          if (!hit) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); return { ok: false, why: 'not in the menu', was, now: was }; }
          hit.click(); await sleep(700);
          const after = picker(); const now = after ? (after.innerText || '').replace(/\\s+/g, ' ').trim() : '';
          return { ok: want.test(now), why: want.test(now) ? '' : 'did not change', was, now };
        })()
        """
    }

    private func setModel(want: String, done: @escaping ([String: Any]) -> Void) {
        claude.callAsyncJavaScript("return await \(modelScript(want: want))", arguments: [:], in: nil, in: .page) { result in
            let answer = ((try? result.get()) as? [String: Any]) ?? ["ok": false, "why": "no answer", "was": "", "now": ""]
            DispatchQueue.main.async { done(answer) }
        }
    }

    func fastModel() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.setModel(want: "haiku") { answer in
                let ok = (answer["ok"] as? Bool) ?? false, was = (answer["was"] as? String) ?? "", now = (answer["now"] as? String) ?? ""
                if ok && !was.isEmpty && was != now && UserDefaults.standard.string(forKey: self.modelKey) == nil { UserDefaults.standard.set(was, forKey: self.modelKey) }
                self.tell("driveModel", ["ok": ok, "was": was, "now": now, "why": (answer["why"] as? String) ?? "", "step": "fast"])
            }
        }
    }

    // Puts back the model that was there before the drive. Also tried when the app next opens, in case a drive was cut short.
    func restoreModel() {
        guard let was = UserDefaults.standard.string(forKey: modelKey), !was.isEmpty else { return }
        let words = was.split(separator: " ").prefix(2).map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: "\\s*")
        if claude.url == nil, let home = URL(string: "https://claude.ai/new") { claude.load(URLRequest(url: home)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            self.setModel(want: words) { answer in
                let ok = (answer["ok"] as? Bool) ?? false
                if ok { UserDefaults.standard.removeObject(forKey: self.modelKey) }
                self.tell("driveModel", ["ok": ok, "was": was, "now": (answer["now"] as? String) ?? "", "why": (answer["why"] as? String) ?? "", "step": "restore"])
            }
        }
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
        tell("driveTrace", ["k": "ask", "want": url.path, "at": claude.url?.path ?? "none", "loading": claude.isLoading])
        if !same(claude.url, url) { claude.load(URLRequest(url: url)); tell("driveStage", ["stage": "opening"]) }
        var tries = 0
        func trySend() {
            guard mine == self.askID else { return }
            tries += 1
            self.tell("driveStage", ["stage": tries == 1 ? "typing" : "retyping", "n": tries])
            claude.callAsyncJavaScript("return await \(sendScript(prompt))", arguments: [:], in: nil, in: .page) { result in
                guard mine == self.askID else { return }
                var failure = ""
                if case .failure(let error) = result { failure = String(error.localizedDescription.prefix(120)) }
                let outcome = (try? result.get()) as? String ?? "none"
                self.tell("driveTrace", ["k": "send", "try": tries, "outcome": outcome, "error": failure, "at": self.claude.url?.path ?? "none", "host": self.claude.url?.host ?? "", "loading": self.claude.isLoading])
                if outcome == "sent" { self.tell("driveStage", ["stage": "sent"]); self.watch(nonce: nonce, id: mine) }
                else if tries < 8 { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { trySend() } }
                else { self.tell("driveAnswer", ["text": "", "done": true, "problem": outcome == "none" ? "Claude did not open. Check you are signed in." : "Claude did not take the question."]) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { trySend() }
    }

    // Reads Claude's page until the spoken answer (between [[SAY]] and [[END]]) is complete.
    private func watch(nonce: String, id: Int) {
        let key = (try? JSONSerialization.data(withJSONObject: [nonce])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        // (also reads whether Claude is still working, and its latest message, in case the answer comes without the marks)
        let read = """
        (() => { const k = \(key)[0], t = document.body ? document.body.innerText : ''; const i = t.lastIndexOf(k); const after = i < 0 ? '' : t.slice(i + k.length);
          const busy = !!document.querySelector('[data-is-streaming="true"]') || [...document.querySelectorAll('button')].some(b => /stop/i.test(b.getAttribute('aria-label') || '') && b.getClientRects().length > 0);
          const all = [...document.querySelectorAll('[data-is-streaming], .font-claude-response, .font-claude-message')]; const el = all[all.length - 1];
          return JSON.stringify({ after: after, busy: busy, last: el ? (el.innerText || '').trim() : '' }); })()
        """
        var ticks = 0
        var last = ""
        var steady = 0
        var everBusy = false
        var quiet = 0
        var ended = false
        var endTicks = 0
        var holdTicks = 0
        var told = ""
        answerTimer?.invalidate()
        answerTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self = self, id == self.askID else { timer.invalidate(); return }
            ticks += 1
            // Patient while Claude is plainly still working (looking through files can take minutes), up to five minutes.
            if ticks > (everBusy ? 750 : 240) { timer.invalidate(); return self.tell("driveAnswer", ["text": "", "done": true, "problem": "Claude has not answered yet. The question is in the chat."]) }
            if everBusy && (ticks == 150 || ticks == 375 || ticks == 600) { self.tell("driveWait", ["n": ticks == 150 ? 1 : 2]) }
            self.claude.evaluateJavaScript(read) { value, _ in
                guard id == self.askID, let raw = value as? String, let data = raw.data(using: .utf8), let page = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
                let after = (page["after"] as? String) ?? "", busy = (page["busy"] as? Bool) ?? false, latest = (page["last"] as? String) ?? ""
                if ticks % 12 == 1 { self.tell("driveTrace", ["k": "watch", "tick": ticks, "busy": busy, "after": after.count, "say": after.contains("[[SAY]]"), "latest": latest.count, "at": self.claude.url?.path ?? "none"]) }
                if busy && !everBusy { self.tell("driveStage", ["stage": "working"]) }
                if ticks == 25 && !busy && !everBusy && after.isEmpty { self.tell("driveStage", ["stage": "unseen"]) }       // ten seconds on and the question is not on Claude's page
                if busy { everBusy = true; quiet = 0 } else { quiet += 1 }
                // Claude's working notes can mention the marks before the answer does: the last [[SAY]] is the answer.
                guard let start = after.range(of: "[[SAY]]", options: .backwards) else {
                    // Claude finished but left out the marks: speak its latest message (the start of it, if it is long).
                    if !busy && everBusy && quiet >= 8 && !latest.isEmpty && after.contains(String(latest.prefix(30))) {
                        timer.invalidate()
                        let words = latest.split(whereSeparator: { $0 == " " || $0 == "\n" })
                        let spoken = words.count > 90 ? words.prefix(90).joined(separator: " ") + ". The rest is in the chat." : words.joined(separator: " ")
                        self.tell("driveAnswer", ["text": spoken, "done": true, "url": self.claude.url?.absoluteString ?? ""])
                    }
                    return
                }
                let rest = String(after[start.upperBound...])
                let address = self.claude.url?.absoluteString ?? ""
                if let end = rest.range(of: "[[END]]") {
                    // Still working and no closing [[DONE]]: this may be a note, not the answer. Give it a few seconds.
                    if !ended && busy && !rest.contains("[[DONE]]") && holdTicks < 12 { holdTicks += 1; return }
                    let answer = String(rest[..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                    if !ended || answer != told {       // (told again only if a newer answer block replaced a note)
                        ended = true; told = answer
                        self.tell("driveAnswer", ["text": answer, "done": true, "url": address])
                    }
                    // After the spoken answer Claude may add one next step ("[[DO]] action | who | what"): wait a moment for it.
                    endTicks += 1
                    let tail = String(rest[end.upperBound...])
                    if tail.contains("[[DONE]]") || endTicks > 20 {
                        timer.invalidate()
                        let steps = tail.components(separatedBy: "\n").filter { $0.contains("[[DO]]") }.map { $0.replacingOccurrences(of: "[[DO]]", with: "").trimmingCharacters(in: .whitespaces) }
                        if !steps.isEmpty { self.tell("driveDo", ["lines": Array(steps.prefix(3))]) }
                    }
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
