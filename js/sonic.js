// sonic.js — Data-over-sound transport for the WebRTC handshake, so two nearby
// devices (iPhone + Quest) can pair with NO server, NO camera/QR, NO typing,
// and NO third device. The only shared medium is air: each has a mic + speaker.
//
// We carry the (gzip-compressed) SDP blob as audio using ggwave (vendored,
// wasm embedded → fully offline). Payloads are chunked + base64'd so each
// ggwave message stays within its ~140-byte limit and survives Emscripten's
// UTF-8 string handling. ggwave adds Reed-Solomon ECC per message; whole-message
// loss is recovered by the caller simply REPEATING until WebRTC connects.

const GG_SRC = new URL('./vendor/ggwave.js', import.meta.url).href;
const CHUNK = 90;           // raw bytes per chunk (before header + base64)

// Carrier protocol. Ultrasound (~15–20 kHz) sits above where speech/music energy
// lives, so it shrugs off most room noise — and being inaudible, we can drive it
// at a higher volume than an audible tone. The decoder auto-detects the protocol
// from the signal, so the two devices need not agree in advance.
const DEFAULT_PROTOCOL = 'GGWAVE_PROTOCOL_ULTRASOUND_FAST';
const VOLUME = 25;          // 0–100; safe to push since the tone is inaudible

let _factoryPromise = null;
function loadFactory() {
  if (_factoryPromise) return _factoryPromise;
  _factoryPromise = new Promise((resolve, reject) => {
    if (globalThis.ggwave_factory) return resolve(globalThis.ggwave_factory);
    const s = document.createElement('script');
    s.src = GG_SRC;
    s.onload = () => resolve(globalThis.ggwave_factory);
    s.onerror = () => reject(new Error('Failed to load ggwave codec'));
    document.head.appendChild(s);
  });
  return _factoryPromise;
}

function reinterpret(src, Type) {
  const buf = new ArrayBuffer(src.byteLength);
  new src.constructor(buf).set(src);
  return new Type(buf);
}

export class SonicLink {
  constructor(opts = {}) {
    this.protocolKey = opts.protocol || DEFAULT_PROTOCOL;
    this.ctx = null;
    this.gg = null;
    this.instance = null;
    this.protocol = null;
    this.mic = null;
    this.node = null;
    this.stream = null;
    this._rx = new Map();        // msgId -> { total, parts:Map<seq,bytes> }
    this._done = new Set();      // msgIds already delivered
    this._onMessage = null;
    this._onProgress = null;     // ({ fraction, receivedBytes, totalBytes }) while streaming
    this._rxAnim = null;         // interval that animates receive progress between chunks
    this._rxSmooth = null;       // current receive-progress interpolation state
    this._rxMaxFrac = 0;         // monotonic guard so the bar never goes backwards
    this._txTimer = null;
  }

  async init() {
    if (this.instance != null) return;
    const factory = await loadFactory();
    this.gg = await factory();
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const p = this.gg.getDefaultParameters();
    p.sampleRateInp = this.ctx.sampleRate;
    p.sampleRateOut = this.ctx.sampleRate;
    this.instance = this.gg.init(p);
    this.protocol = this.gg.ProtocolId[this.protocolKey] ?? this.gg.ProtocolId[DEFAULT_PROTOCOL];
  }

  // ---- receive: open the mic and decode incoming chunks ----
  async startListening(onMessage, onProgress) {
    await this.init();
    this._onMessage = onMessage;
    this._onProgress = onProgress || null;
    this._rxMaxFrac = 0;
    this._rxSmooth = { mode: 'pre', startTime: performance.now() / 1000 };
    this._startRxTicker();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.mic = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this._decodeWindow(e.inputBuffer.getChannelData(0));
    this.mic.connect(this.node);
    this.node.connect(this.ctx.destination); // ScriptProcessor needs a sink to run
  }

  stopListening() {
    try { this.node?.disconnect(); this.mic?.disconnect(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this._rxAnim) { clearInterval(this._rxAnim); this._rxAnim = null; }
    this._rxSmooth = null;
    this.node = this.mic = this.stream = null;
  }

  // ---- transmit: play a payload once, streaming progress by playback time ----
  // ggwave emits one waveform per chunk; we know each waveform's exact duration,
  // so the bar can fill continuously as the sound actually plays (not per-chunk).
  async send(bytes, onProgress) {
    await this.init();
    const waves = this._frames(bytes).map((f) => this._encodeWave(f));
    const sr = this.ctx.sampleRate;
    const durs = waves.map((w) => w.length / sr);
    const totalDur = durs.reduce((a, b) => a + b, 0) || 1;
    const emit = (frac) => {
      const f = Math.min(1, Math.max(0, frac));
      onProgress?.({ fraction: f, sentBytes: Math.round(f * bytes.length), totalBytes: bytes.length });
    };
    let before = 0;
    for (let i = 0; i < waves.length; i++) {
      const start = this.ctx.currentTime;
      const playP = this._playWave(waves[i]);
      let running = true;
      const tick = () => {
        if (!running) return;
        const el = before + (this.ctx.currentTime - start);
        emit(el / totalDur);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await playP;
      running = false;
      before += durs[i];
      emit(before / totalDur);
    }
  }

  // Estimate how many milliseconds of audio a `byteLen`-byte payload takes on
  // this protocol. Used to derive a safe ARQ retransmission timeout (RTO) from
  // the actual symbol air-time instead of a guessed constant. Requires init().
  airtimeMs(byteLen) {
    const dummy = new Uint8Array(Math.max(1, byteLen));
    let samples = 0;
    for (const f of this._frames(dummy)) samples += this._encodeWave(f).length;
    return (samples / this.ctx.sampleRate) * 1000;
  }

  // Split a payload into base64 chunk frames: [msgId, seq, total, ...slice].
  // One ggwave message per frame, kept under its ~140-byte payload limit.
  _frames(bytes) {
    const msgId = (Math.random() * 255) | 0;
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
    const frames = [];
    for (let seq = 0; seq < total; seq++) {
      const slice = bytes.subarray(seq * CHUNK, seq * CHUNK + CHUNK);
      const frame = new Uint8Array(3 + slice.length);
      frame[0] = msgId; frame[1] = seq; frame[2] = total;
      frame.set(slice, 3);
      frames.push(b64encode(frame));
    }
    return frames;
  }

  // Decode the same way the mic does, in 4096-sample windows. Exposed so an
  // offline test can feed a synthesized waveform through the real decode path.
  pushSamples(float32) {
    const W = 4096;
    for (let off = 0; off < float32.length; off += W) {
      this._decodeWindow(float32.subarray(off, off + W));
    }
  }

  // Repeatedly send `bytes` until shouldStop() returns true (handshake ack via
  // the WebRTC connection itself) or maxRepeats is reached. Resolves when done.
  async sendUntil(bytes, shouldStop, { gapMs = 600, maxRepeats = Infinity, onProgress } = {}) {
    let n = 0;
    while (!shouldStop() && n < maxRepeats) {
      await this.send(bytes, onProgress);
      n++;
      if (shouldStop() || n >= maxRepeats) break;
      await delay(gapMs);
    }
  }

  destroy() {
    this.stopListening();
    if (this._rxAnim) { clearInterval(this._rxAnim); this._rxAnim = null; }
    if (this._txTimer) clearTimeout(this._txTimer);
    try { this.ctx?.close(); } catch { /* noop */ }
  }

  // ---- internals ----
  _decodeWindow(samples) {
    const res = this.gg.decode(this.instance, reinterpret(new Float32Array(samples), Int8Array));
    if (res && res.length > 0) this._ingest(new Uint8Array(res));
  }

  _encodeWave(payloadStr) {
    const waveform = this.gg.encode(this.instance, payloadStr, this.protocol, VOLUME);
    return reinterpret(waveform, Float32Array);
  }

  _playWave(f32) {
    const buf = this.ctx.createBuffer(1, f32.length, this.ctx.sampleRate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    return new Promise((resolve) => { src.onended = resolve; src.start(); });
  }

  _playMessage(payloadStr) {
    return this._playWave(this._encodeWave(payloadStr));
  }

  // Animate receive progress between (slow) chunk arrivals so the bar streams
  // smoothly instead of jumping. Before the first chunk we don't yet know the
  // size, so we ease toward a small cap just to show we're listening; after each
  // chunk we interpolate toward the next chunk boundary, then snap on arrival.
  _startRxTicker() {
    if (this._rxAnim) return;
    this._rxAnim = setInterval(() => {
      const s = this._rxSmooth;
      if (!s) return;
      const now = performance.now() / 1000;
      if (s.mode === 'pre') {
        const frac = 0.08 * (1 - Math.exp(-(now - s.startTime) / 4));
        this._emitRx(frac, null, null);
      } else if (s.mode === 'chunk') {
        const span = s.nextBoundary - s.decodedBytes;
        const t = Math.min(1, (now - s.anchorTime) / s.estGap);
        const bytes = s.decodedBytes + span * t * 0.85; // stop short; snap on real arrival
        this._emitRx(bytes / s.totalBytes, Math.round(bytes), s.totalBytes);
      }
    }, 80);
  }

  _emitRx(fraction, receivedBytes, totalBytes) {
    if (fraction < this._rxMaxFrac) fraction = this._rxMaxFrac;
    else this._rxMaxFrac = fraction;
    this._onProgress?.({ fraction, receivedBytes, totalBytes });
  }

  _ingest(payloadBytes) {
    let frame;
    try { frame = b64decode(new TextDecoder().decode(payloadBytes)); }
    catch { return; }
    if (frame.length < 3) return;
    const [msgId, seq, total] = frame;
    if (this._done.has(msgId)) return;
    let rec = this._rx.get(msgId);
    if (!rec) { rec = { total, parts: new Map(), bytes: 0, lastLen: null, estGap: 0, lastArrival: null }; this._rx.set(msgId, rec); }
    const now = performance.now() / 1000;
    if (!rec.parts.has(seq)) {
      const payload = frame.subarray(3);
      rec.parts.set(seq, payload);
      rec.bytes += payload.length;
      if (seq === rec.total - 1) rec.lastLen = payload.length;
      if (rec.lastArrival != null) {
        const gap = now - rec.lastArrival;
        rec.estGap = rec.estGap ? rec.estGap * 0.5 + gap * 0.5 : gap;
      }
      rec.lastArrival = now;
    }
    // Total payload size: every chunk is CHUNK bytes except the last one.
    const totalBytes = (rec.total - 1) * CHUNK + (rec.lastLen ?? CHUNK);
    if (rec.parts.size === rec.total) {
      this._rxSmooth = { mode: 'done' };
      this._emitRx(1, totalBytes, totalBytes);
      const out = concatChunks(rec, total);
      this._rx.delete(msgId); this._done.add(msgId);
      this._onMessage?.(out);
    } else {
      // Seed smooth interpolation toward the next chunk boundary.
      this._rxSmooth = {
        mode: 'chunk',
        decodedBytes: rec.bytes,
        nextBoundary: Math.min(totalBytes, rec.bytes + CHUNK),
        totalBytes,
        anchorTime: now,
        estGap: rec.estGap || 3,
      };
      this._emitRx(rec.bytes / totalBytes, rec.bytes, totalBytes);
    }
  }
}

function concatChunks(rec, total) {
  const ordered = [];
  for (let i = 0; i < total; i++) ordered.push(rec.parts.get(i) || new Uint8Array(0));
  const len = ordered.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of ordered) { out.set(c, off); off += c.length; }
  return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
