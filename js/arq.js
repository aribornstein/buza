// arq.js — Stop-and-Wait ARQ (the Alternating Bit Protocol) for reliable
// delivery over a HALF-DUPLEX, lossy, high-latency link: here, data-over-sound.
//
// Why this and not an ad-hoc "beep until it works": reliable transfer over an
// unreliable link is a solved problem. Stop-and-Wait ARQ is the canonical
// minimal algorithm — send one frame, wait for an acknowledgement, retransmit
// on timeout — and the Alternating Bit Protocol is its correct form, using a
// 1-bit sequence number so a retransmission that the peer already received is
// re-ACKed but not re-delivered.
//
// The one rule that makes it work (and the one our earlier hand-rolled version
// broke): the retransmission timeout (RTO) MUST exceed the round-trip time. On
// a sound link a single symbol is several seconds of air-time, so the RTO is
// derived from the measured symbol air-time rather than a guessed constant —
// see how `rtoMs` is computed by the caller from SonicLink.airtimeMs().
//
// Frame = 1 control byte, then (for DATA) the payload:
//   bit 7  ACK   1 = bare acknowledgement, 0 = DATA carrying a payload
//   bit 1  ROLE  sender's role: 0 = initiator (client), 1 = responder (gateway)
//   bit 0  SEQ   alternating sequence bit
//
// The ROLE bit lets each side ignore its OWN microphone echo (a device hears
// its own speaker) and tells the two DATA directions apart on the shared air.

const ACK = 0x80;
const ROLE = 0x02;
const SEQ = 0x01;

export class StopWaitARQ {
  // send(bytes, onProgress?) -> Promise that resolves when the audio has played.
  // role: 0 (initiator/client) or 1 (responder/gateway).
  // rtoMs: retransmission timeout; MUST be > one round-trip (caller derives it
  //        from the codec's symbol air-time).
  constructor({ send, role, rtoMs, maxRetries = 8, jitter = 0.5 }) {
    this._sendFn = send;
    this._role = role ? 1 : 0;
    this._rtoMs = rtoMs;
    this._maxRetries = maxRetries;
    this._jitter = jitter;    // randomized backoff fraction (breaks collision lock-step)
    this._txSeq = 0;          // sequence bit for frames WE send
    this._rxExpected = 0;     // sequence bit we next expect to RECEIVE
    this._pendingAck = null;  // { seq, resolve } for an in-flight deliver()
    this._txChain = Promise.resolve(); // serialize all sends (half-duplex: one tone at a time)
    this._onData = null;
  }

  // Called with each fully delivered application payload (once per logical frame).
  set onData(cb) { this._onData = cb; }

  // Reliably deliver `payload`. Resolves true once the peer ACKs it, or false
  // if it's still unacknowledged after maxRetries (caller decides what to do).
  async deliver(payload, onProgress) {
    const seq = this._txSeq;
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = (this._role ? ROLE : 0) | seq; // DATA (ACK bit clear)
    frame.set(payload, 1);
    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      let resolveAck;
      const acked = new Promise((res) => { resolveAck = res; });
      this._pendingAck = { seq, resolve: resolveAck };
      await this._send(frame, onProgress);
      // RTO starts only AFTER our tone finishes — the peer can't ACK until then.
      // Add randomized backoff so two peers retransmitting on the same clock
      // don't collide forever (the CSMA/Ethernet lesson): grow the window a bit
      // each attempt and jitter it.
      const wait = this._rtoMs * (1 + 0.25 * attempt) * (1 + Math.random() * this._jitter);
      const ok = await Promise.race([
        acked,
        new Promise((res) => setTimeout(() => res(false), wait)),
      ]);
      this._pendingAck = null;
      if (ok) { this._txSeq ^= 1; return true; }
    }
    return false;
  }

  // Feed a raw frame decoded off the wire (wire the link's onMessage to this).
  feed(raw) {
    if (!raw || raw.length < 1) return;
    const ctrl = raw[0];
    const senderRole = (ctrl & ROLE) ? 1 : 0;
    if (senderRole === this._role) return; // our own echo — ignore
    const seq = ctrl & SEQ;
    if (ctrl & ACK) {
      if (this._pendingAck && this._pendingAck.seq === seq) this._pendingAck.resolve(true);
      return;
    }
    // DATA: always acknowledge (even a duplicate, so the peer can stop), but
    // deliver the payload up only the first time we see this sequence bit.
    const ackFrame = Uint8Array.of(ACK | (this._role ? ROLE : 0) | seq);
    this._send(ackFrame);
    if (seq === this._rxExpected) {
      this._rxExpected ^= 1;
      this._onData?.(raw.subarray(1));
    }
  }

  // Serialize every transmission: the link is half-duplex, so two overlapping
  // tones would corrupt each other.
  _send(bytes, onProgress) {
    this._txChain = this._txChain.then(() => this._sendFn(bytes, onProgress)).catch(() => {});
    return this._txChain;
  }
}
