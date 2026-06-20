// sdp.js — Compact codec for a server-less WebRTC handshake.
//
// A data-channel-only offer/answer is ~1.4 KB, but almost all of it is fixed
// boilerplate (codec lines, SCTP params, BUNDLE group…). Only a handful of
// fields actually vary between connections:
//
//   • type            offer | answer
//   • ice-ufrag       ~4 chars
//   • ice-pwd         ~24 chars
//   • fingerprint     sha-256, 32 raw bytes
//   • setup role      actpass | active | passive
//   • candidate(s)    type + address + port (+ priority)
//
// We pack just those into ~130 bytes of binary and rebuild a canonical SDP on
// the far side. That's small enough to cross a tiny channel reliably — two
// ggwave chunks over sound instead of eleven, or a dense QR / short paste.
//
// Both peers run identical templates, so the rebuilt SDP only needs to carry
// the negotiable bits; the constant lines are reproduced verbatim.

const SETUP = ['actpass', 'active', 'passive', 'holdconn'];
const CTYPE = ['host', 'srflx', 'prflx', 'relay'];

// ---- pack: RTCSessionDescription → compact Uint8Array ----
export function packSignal(desc) {
  const sdp = desc.sdp || '';
  const ufrag = field(sdp, 'ice-ufrag');
  const pwd = field(sdp, 'ice-pwd');
  const fpLine = field(sdp, 'fingerprint');            // "sha-256 AB:CD:…"
  const setup = field(sdp, 'setup') || 'actpass';
  const fpBytes = fixLen(hexToBytes((fpLine.split(/\s+/)[1] || '')), 32);
  const cands = [...sdp.matchAll(/^a=candidate:(.+)$/gm)]
    .map((m) => packCandidate(m[1].trim()))
    .filter(Boolean);

  const w = new ByteWriter();
  w.u8(desc.type === 'answer' ? 1 : 0);
  w.str(ufrag);
  w.str(pwd);
  w.raw(fpBytes);                                       // exactly 32
  w.u8(Math.max(0, SETUP.indexOf(setup)));
  w.u8(Math.min(cands.length, 255));
  for (const c of cands.slice(0, 255)) {
    w.u8(c.type); w.u8(c.comp); w.u8(c.proto);
    w.u32(c.prio); w.u16(c.port); w.str(c.addr);
  }
  return w.done();
}

// ---- unpack: compact Uint8Array → { type, sdp } ----
export function unpackSignal(bytes) {
  const r = new ByteReader(bytes);
  const type = r.u8() === 1 ? 'answer' : 'offer';
  const ufrag = r.str();
  const pwd = r.str();
  const fpHex = bytesToHex(r.raw(32));
  const setup = SETUP[r.u8()] || 'actpass';
  const n = r.u8();
  const cands = [];
  for (let i = 0; i < n; i++) {
    const type_ = r.u8(), comp = r.u8(), proto = r.u8();
    const prio = r.u32(), port = r.u16(), addr = r.str();
    cands.push(buildCandidate(i + 1, { type: type_, comp, proto, prio, port, addr }));
  }
  return { type, sdp: buildSdp({ ufrag, pwd, fpHex, setup, cands }) };
}

// ---- candidate (de)serialization ----
// Wire form: "<foundation> <comp> <transport> <priority> <addr> <port> typ <type> …"
function packCandidate(line) {
  const p = line.split(/\s+/);
  if (p.length < 8 || p[6] !== 'typ') return null;
  if (p[2].toLowerCase() !== 'udp') return null;        // UDP only (TCP rarely used here)
  const type = CTYPE.indexOf(p[7].toLowerCase());
  if (type < 0) return null;
  return {
    type,
    comp: (parseInt(p[1], 10) || 1) & 0xff,
    proto: 0,                                           // 0 = udp
    prio: (parseInt(p[3], 10) || 0) >>> 0,
    addr: p[4],
    port: (parseInt(p[5], 10) || 0) & 0xffff,
  };
}

function buildCandidate(foundation, c) {
  const proto = c.proto === 1 ? 'tcp' : 'udp';
  const type = CTYPE[c.type] || 'host';
  let s = `candidate:${foundation} ${c.comp} ${proto} ${c.prio} ${c.addr} ${c.port} typ ${type}`;
  if (type !== 'host') s += ' raddr 0.0.0.0 rport 0';   // keep the grammar happy
  return s;
}

// ---- canonical data-channel SDP template ----
function buildSdp({ ufrag, pwd, fpHex, setup, cands }) {
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...cands.map((c) => 'a=' + c),
    'a=ice-ufrag:' + ufrag,
    'a=ice-pwd:' + pwd,
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 ' + fpHex,
    'a=setup:' + setup,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  return lines.join('\r\n') + '\r\n';
}

// ---- helpers ----
function field(sdp, name) {
  const m = sdp.match(new RegExp('^a=' + name + ':(.*)$', 'm'));
  return m ? m[1].trim() : '';
}

function hexToBytes(hex) {
  const clean = (hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function fixLen(bytes, n) {
  if (bytes.length === n) return bytes;
  const out = new Uint8Array(n);
  out.set(bytes.subarray(0, n));
  return out;
}

class ByteWriter {
  constructor() { this.buf = new Uint8Array(256); this.len = 0; }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v) { this._ensure(1); this.buf[this.len++] = v & 0xff; }
  u16(v) { this.u8(v >> 8); this.u8(v); }
  u32(v) { this.u8(v >> 24); this.u8(v >> 16); this.u8(v >> 8); this.u8(v); }
  raw(bytes) { this._ensure(bytes.length); this.buf.set(bytes, this.len); this.len += bytes.length; }
  str(s) {
    const b = new TextEncoder().encode(s || '');
    this.u8(Math.min(b.length, 255));
    this.raw(b.subarray(0, 255));
  }
  done() { return this.buf.slice(0, this.len); }
}

class ByteReader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  u8() { return this.b[this.i++] & 0xff; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0; }
  raw(n) { const out = this.b.subarray(this.i, this.i + n); this.i += n; return out; }
  str() { const n = this.u8(); return new TextDecoder().decode(this.raw(n)); }
}
