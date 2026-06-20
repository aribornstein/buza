# Roadmap & TODO

A prioritized list of features, fixes, and polish for the Palestinian Arabic Tutor. Checkboxes track status; rough priority is noted with 🔴 (high) / 🟡 (medium) / 🟢 (nice-to-have).

---

## 🔴 Core experience

- [ ] **Conversation persistence** — save transcript + dialect to `localStorage`/IndexedDB so a session survives a refresh; add a "Clear chat" button.
- [ ] **Stop / interrupt generation** — let the user cancel a streaming reply mid-token (the `reply()` signal plumbing exists in `llm.js`; wire a UI button).
- [ ] **Better error UX on model load** — distinguish "out of GPU memory", "WebGPU disabled", and "network/download failed" with actionable messages in `main.js`.
- [ ] **Replay audio** — a speaker icon on each tutor reply to re-hear the Arabic line on demand.
- [ ] **Pronunciation practice loop** — record the learner repeating a phrase, transcribe it, and compare against the target with simple feedback.

## 🔴 Companion mode (WebRTC + sound)

- [ ] **Real-device test pass** — validate `sonic.js` pairing on iPhone ↔ Quest over a hotspot LAN (blocked locally by sandbox mic/mDNS).
- [ ] **PWA / offline install** — add a service worker + manifest so the app keeps a secure context and runs offline on the go (required for iOS Safari mic over hotspot).
- [ ] **SDP compaction** — strip the SDP to ufrag/pwd/fingerprint/candidate and rebuild from a template so the handshake fits in a single ~1s chirp per direction (fewer chunks, fewer collisions).
- [ ] **Pairing progress UI** — show chunk-reassembly progress and a clear "listening / emitting / connected" state machine during sonic pairing.
- [ ] **Reconnect handling** — detect dropped data channels and re-pair gracefully instead of requiring a page reload.

## 🟡 Language & tutoring quality

- [ ] **Higher-quality Arabic TTS** — Web Speech voices are inconsistent; evaluate an on-device neural TTS (e.g. a WebGPU/ONNX Arabic voice) as a fallback when no system voice exists.
- [ ] **Diacritization (tashkeel)** option for the Arabic line to aid pronunciation.
- [ ] **Vocabulary / phrasebook** — tap a word to see meaning, save it to a review list, and quiz with spaced repetition.
- [ ] **Scenario prompts** — guided role-plays (market, taxi, café, introductions) with goals.
- [ ] **More dialects** — extend `SYSTEM_PROMPTS` beyond Palestinian/MSA (e.g. Egyptian, Levantine-general) with a richer selector.
- [ ] **Robust reply parsing** — make `parseReply()` tolerant of models that drop the `AR/TR/EN` labels or reorder them.

## 🟡 Avatar & UX

- [ ] **Improved lip-sync** — drive mouth shapes from TTS boundary/viseme events rather than a generic pulse.
- [ ] **Expressions / idle animation** — subtle blinking, nodding, and "thinking" states.
- [ ] **Accessibility** — keyboard navigation, ARIA roles on the composer/transcript, reduced-motion support, and high-contrast theme.
- [ ] **RTL/layout polish** — verify mixed Arabic/English rendering and long-message wrapping on mobile.
- [ ] **Settings panel** — voice selection, speech rate, model choice, and "speak replies" defaults persisted.

## 🟢 Performance & platform

- [ ] **Model size options** — let users pick a smaller/faster Whisper or quantized Gemma variant on low-end GPUs.
- [ ] **Warmup & caching feedback** — surface weight-download caching status and a one-time "first run is slow" notice.
- [ ] **Cross-origin isolation path** — optionally serve with COOP/COEP headers to enable multi-threaded Whisper for faster ASR.
- [ ] **Telemetry-free perf metrics** — local-only timing (ASR ms, tokens/sec) shown in a debug overlay.

## 🟢 Project / repo health

- [ ] **License** — add a `LICENSE` file and a license badge/section in the README.
- [ ] **Troubleshooting guide** — common failures (WebGPU off, OOM, no Arabic voice, mic blocked) and fixes.
- [ ] **Screenshots / demo GIF** in the README.
- [ ] **Basic tests** — unit-test `parseReply()`, the SDP encode/decode in `rtc.js`, and the sonic chunk framing in `sonic.js`.
- [ ] **Lint/format config** — add ESLint + Prettier for consistent style.
- [ ] **CONTRIBUTING + issue templates** if the project goes public.

## 🟢 Stretch ideas

- [ ] **Offline-first bundle** — vendor all CDN libraries locally so the app has zero network dependencies after first load.
- [ ] **Shared sessions** — export/import a conversation, or share a phrase set via a link/QR.
- [ ] **Gamification** — streaks, daily phrases, and progress tracking.
- [ ] **Native iPhone gateway** — a small native app exposing a local server over Personal Hotspot, removing WebRTC signaling entirely for the most robust on-the-go path.
