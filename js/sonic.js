// sonic.js — Data-over-sound transport for the WebRTC handshake, so two nearby
// devices (iPhone + Quest) can pair with NO server, NO camera/QR, NO typing,
// and NO third device. The only shared medium is air: each has a mic + speaker.
//
// We carry the (gzip-compressed) SDP blob as audio using ggwave (vendored,
// wasm embedded → fully offline). Payloads are chunked + base64'd so each
// ggwave message stays within its ~140-byte limit and survives Emscripten's
// UTF-8 string handling. ggwave adds Reed-Solomon ECC per message; whole-message
// loss is recovered by the caller simply REPEATING until WebRTC connects.

const GG_SRC = './js/vendor/ggwave.js';
const CHUNK = 90;           // raw bytes per chunk (before header + base64)
const PROTOCOL_KEY = 'GGWAVE_PROTOCOL_AUDIBLE_FAST';
const VOLUME = 12;

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
  constructor() {
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
    this.protocol = this.gg.ProtocolId[PROTOCOL_KEY];
  }

  // ---- receive: open the mic and decode incoming chunks ----
  async startListening(onMessage) {
    await this.init();
    this._onMessage = onMessage;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.mic = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const samples = e.inputBuffer.getChannelData(0);
      const res = this.gg.decode(this.instance, reinterpret(new Float32Array(samples), Int8Array));
      if (res && res.length > 0) this._ingest(new Uint8Array(res));
    };
    this.mic.connect(this.node);
    this.node.connect(this.ctx.destination); // ScriptProcessor needs a sink to run
  }

  stopListening() {
    try { this.node?.disconnect(); this.mic?.disconnect(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = this.mic = this.stream = null;
  }

  // ---- transmit: play a payload once, as a sequence of chunk messages ----
  async send(bytes) {
    await this.init();
    const msgId = (Math.random() * 255) | 0;
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let seq = 0; seq < total; seq++) {
      const slice = bytes.subarray(seq * CHUNK, seq * CHUNK + CHUNK);
      const frame = new Uint8Array(3 + slice.length);
      frame[0] = msgId; frame[1] = seq; frame[2] = total;
      frame.set(slice, 3);
      await this._playMessage(b64encode(frame));
    }
  }

  // Repeatedly send `bytes` until shouldStop() returns true (handshake ack via
  // the WebRTC connection itself) or maxRepeats is reached. Resolves when done.
  async sendUntil(bytes, shouldStop, { gapMs = 600, maxRepeats = Infinity } = {}) {
    let n = 0;
    while (!shouldStop() && n < maxRepeats) {
      await this.send(bytes);
      n++;
      if (shouldStop() || n >= maxRepeats) break;
      await delay(gapMs);
    }
  }

  destroy() {
    this.stopListening();
    if (this._txTimer) clearTimeout(this._txTimer);
    try { this.ctx?.close(); } catch { /* noop */ }
  }

  // ---- internals ----
  _playMessage(payloadStr) {
    const waveform = this.gg.encode(this.instance, payloadStr, this.protocol, VOLUME);
    const f32 = reinterpret(waveform, Float32Array);
    const buf = this.ctx.createBuffer(1, f32.length, this.ctx.sampleRate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    return new Promise((resolve) => { src.onended = resolve; src.start(); });
  }

  _ingest(payloadBytes) {
    let frame;
    try { frame = b64decode(new TextDecoder().decode(payloadBytes)); }
    catch { return; }
    if (frame.length < 3) return;
    const [msgId, seq, total] = frame;
    if (this._done.has(msgId)) return;
    let rec = this._rx.get(msgId);
    if (!rec) { rec = { total, parts: new Map() }; this._rx.set(msgId, rec); }
    rec.parts.set(seq, frame.subarray(3));
    if (rec.parts.size === rec.total) {
      const out = concatChunks(rec, total);
      this._rx.delete(msgId); this._done.add(msgId);
      this._onMessage?.(out);
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
