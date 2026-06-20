// rtc.js — A tiny, server-less WebRTC peer for the companion gateway.
//
// Transport is DATA-CHANNEL ONLY (no media tracks), so neither side needs camera
// negotiation and the Quest client needs no WebGPU at all — the iPhone gateway
// does every heavy thing (Whisper + Gemma) and streams text back.
//
// Two channels:
//   • "control" — JSON control messages + chunked binary audio clips
//   • "tokens"  — streamed reply text from the model
//
// Signaling is MANUAL (no server): each side produces a compact, gzip+base64
// encoded SDP blob that the other side pastes/scans. We wait for ICE gathering
// to COMPLETE before emitting the blob, so all candidates are embedded (no
// trickle) — required when there's no signaling channel.

import { packSignal, unpackSignal } from './sdp.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CHUNK = 16 * 1024;            // audio chunk size over the data channel
const DRAIN_THRESHOLD = 256 * 1024; // pause sending when bufferedAmount exceeds this

export class RTCPeer {
  constructor({ initiator }) {
    this.initiator = initiator;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.control = null;
    this.tokens = null;
    this._handlers = {};
    this._rxAudio = null; // { meta, chunks: [] } while a clip is arriving
    this._openCount = 0;
    this._ready = new Promise((res) => { this._readyResolve = res; });

    this.pc.onconnectionstatechange = () =>
      this._emit('state', this.pc.connectionState);

    if (initiator) {
      // The initiator owns channel creation; the answerer receives them.
      this._setupChannel(this.pc.createDataChannel('control', { ordered: true }));
      this._setupChannel(this.pc.createDataChannel('tokens', { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this._setupChannel(e.channel);
    }
  }

  // ---- events: 'control' | 'audio' | 'token' | 'state' | 'open' ----
  on(event, cb) { this._handlers[event] = cb; return this; }
  _emit(event, ...args) { this._handlers[event]?.(...args); }

  /** Resolves once both data channels are open. */
  whenReady() { return this._ready; }

  // ---- manual signaling ----
  async createOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return encodeSignal(await this._gathered());
  }

  async createAnswer(remoteBlob, { fastIce = false } = {}) {
    await this.pc.setRemoteDescription(await decodeSignal(remoteBlob));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return encodeSignal(await this._gathered(fastIce ? 1200 : 2500, { fast: fastIce }));
  }

  async acceptAnswer(remoteBlob) {
    await this.pc.setRemoteDescription(await decodeSignal(remoteBlob));
  }

  // ---- sending ----
  /** Send a JSON control message. */
  send(obj) { this._safeSend(this.control, JSON.stringify(obj)); }

  /** Send a streamed reply update on the tokens channel. */
  sendToken(obj) { this._safeSend(this.tokens, JSON.stringify(obj)); }

  /** Send a recorded audio clip (Blob) over the control channel, chunked. */
  async sendAudio(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = Math.random().toString(36).slice(2);
    this.send({ type: 'audio-begin', id, mime: blob.type, size: bytes.byteLength });
    for (let off = 0; off < bytes.byteLength; off += CHUNK) {
      await this._drain(this.control);
      this.control.send(bytes.subarray(off, off + CHUNK));
    }
    this.send({ type: 'audio-end', id });
  }

  close() { try { this.pc.close(); } catch { /* already closed */ } }

  // ---- internals ----
  _setupChannel(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'control') this.control = ch;
    if (ch.label === 'tokens') this.tokens = ch;

    ch.onopen = () => {
      if (++this._openCount >= 2) { this._emit('open'); this._readyResolve(); }
    };
    ch.onmessage = (e) => this._onMessage(ch, e.data);
  }

  _onMessage(ch, data) {
    // Binary frames are always audio-clip chunks on the control channel.
    if (data instanceof ArrayBuffer) {
      if (this._rxAudio) this._rxAudio.chunks.push(new Uint8Array(data));
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (ch.label === 'tokens') { this._emit('token', msg); return; }

    switch (msg.type) {
      case 'audio-begin':
        this._rxAudio = { meta: msg, chunks: [] };
        break;
      case 'audio-end': {
        if (!this._rxAudio) break;
        const blob = new Blob(this._rxAudio.chunks, { type: this._rxAudio.meta.mime });
        this._rxAudio = null;
        this._emit('audio', blob);
        break;
      }
      default:
        this._emit('control', msg);
    }
  }

  _safeSend(ch, payload) {
    if (ch && ch.readyState === 'open') ch.send(payload);
  }

  _drain(ch) {
    if (ch.bufferedAmount < DRAIN_THRESHOLD) return Promise.resolve();
    return new Promise((res) => {
      const t = setInterval(() => {
        if (ch.bufferedAmount < DRAIN_THRESHOLD) { clearInterval(t); res(); }
      }, 50);
    });
  }

  _gathered(timeoutMs = 2500, { fast = false } = {}) {
    if (this.pc.iceGatheringState === 'complete') {
      return Promise.resolve(this.pc.localDescription);
    }
    // Non-trickle, but resilient: iOS Safari often never reports gathering
    // 'complete' (and may stall on the STUN srflx candidate). So we resolve on
    // ANY of: gathering complete, end-of-candidates (null icecandidate), or a
    // short timeout — emitting whatever candidates we have. Host/mDNS candidates
    // alone are enough on the same LAN (e.g. an iPhone hotspot).
    //
    // In `fast` mode (used for SAME-ROOM acoustic pairing, where the two devices
    // are inches apart and almost certainly share a network) we stop a short
    // grace period after the FIRST local candidate instead of waiting out the
    // full srflx timeout — this removes the multi-second pause before the
    // gateway can start emitting its answer.
    return new Promise((res) => {
      let done = false;
      let grace = null;
      const finish = () => {
        if (done) return;
        done = true;
        this.pc.removeEventListener('icegatheringstatechange', onChange);
        this.pc.removeEventListener('icecandidate', onCand);
        clearTimeout(timer);
        clearTimeout(grace);
        res(this.pc.localDescription);
      };
      const onChange = () => { if (this.pc.iceGatheringState === 'complete') finish(); };
      const onCand = (e) => {
        if (!e.candidate) return finish();        // end-of-candidates marker
        if (fast && !grace) grace = setTimeout(finish, 300); // got a host candidate; don't wait for srflx
      };
      this.pc.addEventListener('icegatheringstatechange', onChange);
      this.pc.addEventListener('icecandidate', onCand);
      const timer = setTimeout(finish, timeoutMs);
    });
  }
}

// ---- compact signal encoding ----
//
// Format byte prefix:
//   'C' — compact codec (sdp.js): only the variable SDP fields, ~130 bytes.
//   'G' — legacy gzip(JSON), 'P' — legacy plain JSON (decode kept for back-compat).
//
// The compact form is what every fresh handshake uses; it's what makes the
// blob small enough to pair reliably over sound (2 chunks instead of ~11).
export function encodeSignal(desc) {
  return 'C' + bytesToB64(packSignal(desc));
}

export async function decodeSignal(blob) {
  const flag = blob[0];
  const bytes = b64ToBytes(blob.slice(1).trim());
  if (flag === 'C') return unpackSignal(bytes);
  const json = new TextDecoder().decode(flag === 'G' ? await gunzip(bytes) : bytes);
  return JSON.parse(json);
}

// Raw <-> blob helpers for the sound transport: over the air we ship the packed
// bytes directly (no base64), saving the extra ~33% that base64 would add.
export function packedToBlob(bytes) { return 'C' + bytesToB64(bytes); }
export function blobToPacked(blob) {
  if (blob[0] !== 'C') throw new Error('sound pairing requires the compact signal format');
  return b64ToBytes(blob.slice(1).trim());
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
