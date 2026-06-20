# مُعلّم · Palestinian Arabic Tutor

A fully **in-browser** conversational tutor for **Palestinian colloquial Arabic** (and Modern Standard Arabic). Speak or type, and a friendly animated avatar replies in dialect with transliteration, an English translation, and spoken audio — all running **locally on your device** with no backend and no API keys.

Everything (speech recognition, the language model, and text-to-speech) runs client-side via **WebGPU** and **WebAssembly**. The first load downloads the models; after that they're cached and the app works offline.

---

## Features

- 🗣️ **Voice in, voice out** — hold-to-talk mic → Whisper transcription → Gemma reply → spoken Arabic with avatar lip-sync.
- ⌨️ **Type instead** — text input works too, in Arabic or English.
- 🇵🇸 **Dialect-aware** — switch between **Palestinian (Levantine)** and **Modern Standard Arabic**.
- 📖 **Three-line replies** — every answer comes as Arabic script (`AR`), Latin transliteration (`TR`), and English (`EN`).
- 🧠 **100% local & private** — no server, no API keys; models run on-device via WebGPU.
- 📱 **Companion mode** — offload the heavy model to a phone and use a thin client on a headset, paired with **no server, no QR, and no typing** (see [Companion mode](#companion-mode-webrtc--data-over-sound)).

---

## How it works

```
mic → Whisper (ASR) → Gemma-4 (chat) → Web Speech (TTS) + avatar lip-sync
```

| Stage | Model / tech | Runtime |
| --- | --- | --- |
| Speech-to-text | [`onnx-community/whisper-base`](https://huggingface.co/onnx-community/whisper-base) | Transformers.js (ONNX Runtime, WebGPU) |
| Language model | `google/gemma-4-E2B-it-qat-mobile-transformers` | `Gemma4Mobile` — self-contained WGSL/WebGPU kernels |
| Text-to-speech | Web Speech API (`speechSynthesis`) | Native browser voices |
| Avatar | three.js | WebGPU/WebGL |

The Gemma runtime is vendored as a self-contained WebGPU bundle ([`js/gemma-4-e2b.js`](js/gemma-4-e2b.js)) with hand-written WGSL kernels — it does **not** use ONNX Runtime, so it sidesteps the `SharedArrayBuffer` / cross-origin-isolation requirement entirely. Whisper still uses Transformers.js, forced to single-threaded mode (`env.backends.onnx.wasm.numThreads = 1`) so it runs without COOP/COEP headers. Approach mirrors the [`webml-community/gemma-4-webgpu-kernels`](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels) demo.

---

## Requirements

- A browser with **WebGPU**: Chrome or Edge **121+** (desktop recommended). Safari support is partial.
- A reasonably modern GPU and enough memory for the model weights.
- A microphone (optional — text input works without one).
- For best spoken output, install an **Arabic system voice** in your OS; otherwise a default voice is used.

> First run downloads the model weights (several hundred MB). They're cached by the browser afterward, so subsequent loads are fast and work offline.

---

## Running locally

The app is plain static files with no build step. Because it loads ES modules, you must serve it over HTTP (not `file://`):

```bash
# from the project root
python3 -m http.server 8753
```

Then open **http://localhost:8753/index.html** and click **Load tutor**.

Any static server works (`npx serve`, `python3 -m http.server`, etc.). All libraries load from CDN as ES modules via an import map — no `npm install` required.

---

## Usage

1. On launch, pick **where the AI runs**:
   - **Run on this device** — loads the models locally (needs WebGPU).
   - **Use a companion device** — this device becomes a light client and offloads the AI to a nearby phone.
   - **Be the companion** — this device runs the AI for another nearby device.
2. If running locally, wait for the models to download/initialize (progress is shown).
3. Pick a **Dialect** (Palestinian or MSA) in the top-right.
4. **Hold the mic button** (or click to toggle) and speak in Arabic, or **type** a message and press Send.
5. The tutor replies with Arabic, transliteration, and English. Toggle **Speak replies** to hear it aloud with avatar lip-sync.

---

## Companion mode (WebRTC + data-over-sound)

For running on the go across two nearby devices — e.g. a **phone** doing inference and a **headset** as a thin client — choose **companion mode** from the startup picker on [`index.html`](index.html), or open [`companion.html`](companion.html) directly and pick a role:

- **Gateway** (`?role=gateway`) → runs Whisper + Gemma and streams replies.
- **Client** (`?role=client`) → mic + avatar + UI only; **no WebGPU needed**.

The two ends connect over a **data-channel-only WebRTC** link with **no signaling server**. Pairing options:

- **Pair by sound** 🔊 — the WebRTC handshake is exchanged acoustically via [ggwave](https://github.com/ggerganov/ggwave) (speaker → mic). No server, no camera/QR, no typing. The WebRTC connection itself acts as the acknowledgment, so each side re-chirps until the link opens. The real stream then rides DTLS-encrypted WebRTC; sound only ever carries the tiny handshake and never leaves the room.
- **Paste / scan** — copy the compact SDP blob between devices manually, or scan its QR with a camera (fallback).

> iOS Safari needs HTTPS and a user tap for microphone/AudioContext. For truly offline on-the-go use, serve over HTTPS and install the app as a PWA so it keeps a secure context.

---

## Project structure

```
index.html          Main all-in-one tutor UI
companion.html      Companion (gateway/client) UI for WebRTC pairing
css/
  styles.css        App styles
js/
  main.js           Orchestrates the main app (mic → Whisper → Gemma → TTS)
  asr.js            Whisper speech-to-text (Transformers.js)
  llm.js            Gemma-4 tutor "brain" + reply parsing
  gemma-4-e2b.js    Self-contained Gemma-4 WebGPU runtime (WGSL kernels)
  tts.js            Web Speech API text-to-speech
  avatar.js         three.js animated avatar + lip-sync
  rtc.js            Server-less WebRTC peer + SDP encode/decode
  companion.js      Drives both companion roles (?role=gateway|client)
  sonic.js          Data-over-sound transport for the WebRTC handshake
  vendor/
    ggwave.js       Vendored ggwave codec (wasm embedded, offline)
```

---

## Privacy

All audio, transcription, and generation happen **on your device**. Nothing is sent to a server. In companion mode the two devices talk peer-to-peer over an encrypted WebRTC channel.

---

## Acknowledgments

- [Hugging Face Transformers.js](https://github.com/huggingface/transformers.js)
- [`webml-community/gemma-4-webgpu-kernels`](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels) — Gemma-4 WebGPU runtime
- [Whisper](https://huggingface.co/onnx-community/whisper-base) by OpenAI / ONNX Community
- [three.js](https://threejs.org/)
- [ggwave](https://github.com/ggerganov/ggwave) — data-over-sound

---

> ⚠️ **Prototype.** This is an experimental, educational project. Dialect coverage and corrections are best-effort and may contain mistakes.
