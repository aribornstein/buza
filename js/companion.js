// companion.js — Drives the WebRTC companion experience for BOTH ends from one
// codebase, selected by ?role=:
//
//   ?role=gateway  → iPhone 17 Pro. Runs Whisper + Gemma-4, streams replies.
//   ?role=client   → Quest 3 (or any browser). Thin client: mic + avatar + UI.
//                    Needs NO WebGPU — all heavy compute lives on the gateway.
//
// Signaling is manual (no server): each side shows a compact SDP blob (text +
// QR); the other side pastes or scans it. See rtc.js for the wire format.

import { RTCPeer, packedToBlob, blobToPacked } from './rtc.js';
import { SonicLink } from './sonic.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roleParam = params.get('role');
const hasRole = roleParam === 'gateway' || roleParam === 'client';
const role = roleParam === 'gateway' ? 'gateway' : 'client';

if (hasRole) {
  document.body.dataset.role = role;
  $('role-badge').textContent = role === 'gateway' ? 'Gateway · iPhone' : 'Client · Quest';
}

// Data-over-sound pairing — shared across roles. Lets the iPhone + Quest swap
// the WebRTC handshake acoustically (no server, no QR/camera, no typing).
let sonic = null;
let sonicTx = null; // client-only: a 2nd link so transmitting never disrupts the listening decoder
function setSound(t) { const el = $('sound-status'); if (el) el.textContent = t; }
function sonicReset() {
  try { sonic?.destroy(); } catch { /* noop */ }
  try { sonicTx?.destroy(); } catch { /* noop */ }
  sonic = new SonicLink(); sonicTx = null;
}

// A tiny "got it" beep the gateway emits the instant it has decoded the FULL
// offer. It's the explicit signal for the client to STOP transmitting and start
// listening for the reply — without it the client can only guess (and talks over
// the answer). It's far shorter than a real signal (≈139 B), so length alone
// distinguishes it from an offer/answer payload.
// Tiny handshake markers (one ggwave chunk each, ~sub-second) used to hand the
// half-duplex acoustic channel cleanly from one side to the other:
//   ACK = gateway → client: "I have your full offer, stop transmitting."
//   RDY = client → gateway: "I'm silent and listening, send the answer now."
// Both are 3 bytes and told apart by content; a real signal is ~139 bytes.
const ACK_BYTES = new TextEncoder().encode('ACK');
const RDY_BYTES = new TextEncoder().encode('RDY');
const bytesEq = (b, ref) => b.length === ref.length && b.every((v, i) => v === ref[i]);
const isAck = (b) => bytesEq(b, ACK_BYTES);
const isRdy = (b) => bytesEq(b, RDY_BYTES);

// Pairing progress bar. Pass a 0..1 fraction to show/update it, or null to hide.
function setProgress(frac) {
  const wrap = $('sonic-progress'); const bar = $('sonic-bar');
  if (!wrap || !bar) return;
  if (frac == null) { wrap.hidden = true; bar.style.width = '0%'; return; }
  wrap.hidden = false;
  bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
}

// ---------- shared signaling UI ----------
async function showLocalSignal(blob) {
  $('local-blob').value = blob;
  const mine = document.querySelector('.signal-box.mine');
  if (mine) mine.style.opacity = '1'; // un-dim once we actually have a code to show
  try {
    const { default: QRCode } = await import('https://esm.sh/qrcode@1.5.4');
    await QRCode.toCanvas($('local-qr'), blob, { errorCorrectionLevel: 'L', margin: 1, width: 280 });
    $('local-qr').style.display = '';
  } catch {
    $('local-qr').style.display = 'none'; // QR is a convenience; text always works
  }
}

function setConn(state) { $('conn-state').textContent = state; }

$('copy-local').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('local-blob').value); $('copy-local').textContent = 'Copied'; }
  catch { $('local-blob').select(); }
  setTimeout(() => ($('copy-local').textContent = 'Copy'), 1200);
});

// Optional camera-based QR scanner (works where camera is granted — e.g. iPhone).
$('scan-btn').addEventListener('click', startScan);
async function startScan() {
  const video = $('scan-video');
  try {
    const jsQR = (await import('https://esm.sh/jsqr@1.4.0')).default;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream; video.style.display = ''; await video.play();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!video.srcObject) return;
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code?.data) {
          $('remote-blob').value = code.data;
          stream.getTracks().forEach((t) => t.stop());
          video.srcObject = null; video.style.display = 'none';
          $('apply-remote').click();
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    $('scan-btn').textContent = 'Camera unavailable — paste instead';
  }
}

// ============================================================ CLIENT (Quest)
async function initClient() {
  const peer = new RTCPeer({ initiator: true });
  let currentEl = null;
  let connected = false;
  let offerBlob = null;
  let avatar = null;
  let speaker = null;

  // 1) Produce our offer and show it FIRST, so the pairing code always appears
  //    even if the optional avatar / voice fail to load (iOS Safari can block
  //    WebGL or speech). Pairing + text chat must never depend on those.
  try {
    offerBlob = await peer.createOffer();
    showLocalSignal(offerBlob);
    $('signal-title').textContent = '1) Show this to the iPhone  ·  2) paste its reply below';
  } catch (e) {
    setConn('error generating code');
    $('signal-title').textContent = 'Could not generate a pairing code — ' + (e?.message || e);
    console.error(e);
  }

  // 2) Optional richer client: 3D avatar + spoken replies. Failures here are
  //    non-fatal — the client stays usable as a plain text/voice relay.
  try {
    const { Avatar } = await import('./avatar.js');
    avatar = new Avatar($('avatar-canvas'));
  } catch (e) { console.warn('Avatar unavailable:', e); }
  try {
    const { Speaker } = await import('./tts.js');
    speaker = new Speaker();
  } catch (e) { console.warn('Speech synthesis unavailable:', e); }

  // 3) Accept the gateway's answer.
  $('apply-remote').addEventListener('click', async () => {
    const blob = $('remote-blob').value.trim();
    if (!blob) return;
    try { await peer.acceptAnswer(blob); setConn('connecting…'); }
    catch (e) { setConn('bad code'); console.error(e); }
  });

  // 3b) Or pair entirely over sound: emit the offer on a loop while listening
  //     for the gateway's spoken answer. We stop emitting once we've heard a
  //     valid answer (the gateway keeps emitting until WebRTC actually opens).
  $('sound-btn').addEventListener('click', async () => {
    if (!offerBlob) { setSound('No pairing code yet — reload the page.'); return; }
    sonicReset();
    // ggwave can't encode and decode on one instance at the same time, so the
    // client listens on `sonic` and emits on a separate `sonicTx` — otherwise
    // emitting the offer would clobber the decoder and we'd miss the reply.
    sonicTx = new SonicLink();
    setProgress(0);
    let received = false;
    let emitting = false;
    let acked = false;
    let rdyBusy = false;
    // Half-duplex over one acoustic channel: while we're emitting the offer our
    // own (loud) tone masks the iPhone's reply, so we can't just blast the offer
    // on a loop. We emit the offer ONCE, then go quiet and wait for the iPhone's
    // ACK beep. When we hear it we stop emitting for good and fire a short RDY
    // beep back so the iPhone knows the channel is clear and can send the answer.
    const waitUntil = (cond, ms) => new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (cond() || Date.now() - t0 >= ms) { clearInterval(iv); resolve(); }
      }, 120);
    });
    // Confirm readiness to the iPhone. Guarded so overlapping ACKs don't stack
    // up multiple RDY chirps on top of each other.
    const sendReady = async () => {
      if (rdyBusy || received || connected) return;
      rdyBusy = true;
      try { await sonicTx.send(RDY_BYTES); } catch { /* noop */ }
      rdyBusy = false;
    };
    try {
      await sonic.startListening(async (bytes) => {
        if (received || connected) return;
        if (isAck(bytes)) { // the iPhone has our full offer → stop transmitting
          if (!acked) { acked = true; setSound('iPhone got the code — telling it I’m ready…'); }
          if (!emitting) sendReady(); // (re)confirm; self-heals a dropped RDY
          return;
        }
        try {
          await peer.acceptAnswer(packedToBlob(bytes));
          received = true; setProgress(1); setSound('Heard the iPhone — connecting…'); setConn('connecting…');
        } catch { /* probably heard our own offer; keep listening */ }
      }, ({ fraction, receivedBytes, totalBytes }) => {
        if (received || emitting || acked) return; // while emitting, the bar shows our outgoing offer
        setProgress(fraction);
        setSound(totalBytes ? `Hearing the iPhone’s reply… ${receivedBytes}/${totalBytes} B` : 'Listening for the iPhone…');
      });
      setSound('Hold the phone close — pairing over sound…');
      for (let attempt = 0; attempt < 8 && !received && !connected && !acked; attempt++) {
        emitting = true;
        await sonicTx.send(blobToPacked(offerBlob), ({ fraction, sentBytes, totalBytes }) => {
          if (!received) { setProgress(fraction); setSound(`Emitting offer… ${sentBytes}/${totalBytes} B`); }
        });
        emitting = false;
        if (received || connected || acked) break;
        // Go quiet and wait for the iPhone's ACK; if none arrives, re-emit.
        setProgress(0); setSound('Offer sent — waiting for the iPhone to confirm…');
        await waitUntil(() => received || connected || acked, 5000);
      }
      // Acknowledged: stop emitting for good and listen for the (longer) answer.
      if (acked && !received && !connected) {
        setProgress(0); setSound('iPhone got it — listening for its reply…');
        await waitUntil(() => received || connected, 30000);
      }
      if (!received && !connected) setSound('No reply heard — move the phone closer and tap again.');
    } catch (e) { setProgress(null); setSound('Microphone/audio blocked: ' + (e?.message || e)); }
  });

  peer.on('state', (s) => setConn(s));
  peer.on('open', () => {
    connected = true;
    setProgress(1);
    try { sonic?.destroy(); } catch { /* noop */ }
    try { sonicTx?.destroy(); } catch { /* noop */ }
    $('signal-panel').classList.add('hidden');
    $('app-panel').classList.remove('hidden');
    setStatus('Connected — say or type something in Arabic!');
    enableComposer(true);
  });

  // Gateway → client control messages (status + recognized speech).
  peer.on('control', (m) => {
    if (m.type === 'status') setStatus(m.text);
    else if (m.type === 'transcript' && m.text) addMessage('user', m.text);
  });

  // Streamed reply text.
  peer.on('token', (m) => {
    if (m.type === 'partial') {
      if (!currentEl) { currentEl = addMessage('tutor', ''); avatar?.setSpeaking(true); }
      renderTutor(currentEl, m.parsed || { ar: m.text, tr: '', en: '' });
      avatar?.pulse(0.8);
    } else if (m.type === 'final') {
      if (!currentEl) currentEl = addMessage('tutor', '');
      renderTutor(currentEl, m.parsed || { ar: m.text, tr: '', en: '' });
      avatar?.setSpeaking(false);
      currentEl = null;
      if (speaker && $('speak-toggle').checked && m.parsed?.ar) {
        speaker.speak(m.parsed.ar, { onBoundary: () => avatar?.pulse(1) });
      }
    }
  });

  // Dialect changes propagate to the gateway.
  $('dialect-select').addEventListener('change', (e) =>
    peer.send({ type: 'dialect', value: e.target.value }));

  // Text input.
  $('send-btn').addEventListener('click', sendText);
  $('text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });
  function sendText() {
    const text = $('text-input').value.trim();
    if (!text) return;
    addMessage('user', text);
    peer.send({ type: 'text', text, dialect: $('dialect-select').value });
    $('text-input').value = '';
  }

  // Push-to-talk: record a clip locally and ship the bytes to the gateway.
  let recorder = null, chunks = [], stream = null;
  const micBtn = $('mic-btn');
  const startRec = async () => {
    if (recorder) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start();
    micBtn.classList.add('recording'); setStatus('Listening…');
  };
  const stopRec = async () => {
    if (!recorder) return;
    const done = new Promise((r) => (recorder.onstop = r));
    recorder.stop(); await done;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType });
    recorder = null; micBtn.classList.remove('recording'); setStatus('Transcribing on iPhone…');
    peer.send({ type: 'dialect', value: $('dialect-select').value });
    await peer.sendAudio(blob);
  };
  micBtn.addEventListener('pointerdown', startRec);
  micBtn.addEventListener('pointerup', stopRec);
  micBtn.addEventListener('pointerleave', stopRec);

  // ---- client DOM helpers ----
  function enableComposer(on) {
    $('mic-btn').disabled = !on; $('send-btn').disabled = !on; $('text-input').disabled = !on;
  }
  function setStatus(t) { $('status-text').textContent = t; }
  function addMessage(roleName, content) {
    const el = document.createElement('div');
    el.className = `msg ${roleName}`;
    if (content) el.textContent = content;
    $('transcript').appendChild(el);
    $('transcript').scrollTop = $('transcript').scrollHeight;
    return el;
  }
  function renderTutor(el, { ar, tr, en }) {
    el.innerHTML = '';
    if (ar) { const d = document.createElement('div'); d.className = 'ar'; d.dir = 'rtl'; d.textContent = ar; el.appendChild(d); }
    if (tr) { const d = document.createElement('div'); d.className = 'translit'; d.textContent = tr; el.appendChild(d); }
    if (en) { const d = document.createElement('div'); d.className = 'en'; d.textContent = en; el.appendChild(d); }
    $('transcript').scrollTop = $('transcript').scrollHeight;
  }
}

// ============================================================ GATEWAY (iPhone)
async function initGateway() {
  $('signal-title').textContent = '1) Scan / paste the Quest\u2019s code  ·  2) show your reply back';
  $('apply-remote').textContent = 'Generate reply code';
  $('local-blob').placeholder = 'Your reply code appears here after you load the Quest’s code.';

  const peer = new RTCPeer({ initiator: false });
  let busy = false;
  let connected = false;
  // Heavy AI deps (Transformers.js + Gemma + Whisper) load LAZILY only after a
  // client connects — so the signaling UI is interactive immediately and a slow
  // or blocked CDN can never make the gateway look “stuck”.
  let tutor = null;
  let stt = null;

  function log(t) { $('gw-status').textContent = t; }
  function toClient(text) { peer.send({ type: 'status', text }); }

  // Answer the Quest's offer.
  $('apply-remote').addEventListener('click', async () => {
    const blob = $('remote-blob').value.trim();
    if (!blob) return;
    try {
      const answer = await peer.createAnswer(blob);
      showLocalSignal(answer);
      $('signal-title').textContent = 'Show / send this reply code to the Quest';
      setConn('connecting…');
    } catch (e) { setConn('bad code'); console.error(e); }
  });

  // Or pair over sound: listen for the Quest's offer, then emit our answer on a
  // loop until WebRTC opens. We stop listening once we have the offer so our own
  // answer chirp doesn't collide with itself on the mic.
  $('sound-btn').addEventListener('click', async () => {
    sonicReset();
    // The gateway listens on `sonic` and transmits on a separate `sonicTx` so it
    // can keep an ear open for the Quest's RDY beep while it's chirping ACKs —
    // one ggwave instance can't encode and decode at the same time.
    sonicTx = new SonicLink();
    setProgress(0);
    let gotOffer = false;
    let ready = false;
    let answerBytes = null;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitUntil = (cond, ms) => new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (cond() || Date.now() - t0 >= ms) { clearInterval(iv); resolve(); }
      }, 120);
    });
    try {
      await sonic.startListening(async (bytes) => {
        if (connected) return;
        if (isRdy(bytes)) { ready = true; return; } // Quest is silent and listening
        if (gotOffer) return; // ignore our own echo / repeats once we have the offer
        try {
          const answer = await peer.createAnswer(packedToBlob(bytes), { fastIce: true });
          gotOffer = true; setProgress(1);
          showLocalSignal(answer);
          setConn('connecting…');
          answerBytes = blobToPacked(answer);
        } catch { /* heard noise or our own audio; keep listening */ }
      }, ({ fraction, receivedBytes, totalBytes }) => {
        if (!gotOffer) { setProgress(fraction); setSound(totalBytes ? `Hearing the Quest’s code… ${receivedBytes}/${totalBytes} B` : 'Listening for the Quest…'); }
      });
      setSound('Hold the phone close to the headset. Listening for the Quest…');
      // Wait until we've decoded the full offer.
      await waitUntil(() => gotOffer || connected, 60000);
      if (gotOffer && !connected) {
        // Phase A — handshake. Chirp a short ACK and listen for the Quest's RDY.
        // Cheap to repeat, so a missed ACK costs ~2s, not a whole answer.
        for (let i = 0; i < 10 && !ready && !connected; i++) {
          setSound('Heard the Quest — telling it to listen…');
          await sonicTx.send(ACK_BYTES);
          if (ready || connected) break;
          await waitUntil(() => ready || connected, 2500);
        }
        // Phase B — payload. Channel is clear; stream the answer until WebRTC
        // opens. Re-ACK between tries in case the Quest fell back to emitting.
        while (!connected) {
          setSound('Replying over sound…');
          await sonicTx.send(answerBytes, ({ fraction, sentBytes, totalBytes }) => {
            if (!connected) { setProgress(fraction); setSound(`Replying over sound… ${sentBytes}/${totalBytes} B`); }
          });
          if (connected) break;
          await delay(300);
          if (connected) break;
          await sonicTx.send(ACK_BYTES); // nudge a Quest that stopped listening
          await delay(300);
        }
      }
    } catch (e) { setProgress(null); setSound('Microphone/audio blocked: ' + (e?.message || e)); }
  });

  peer.on('state', (s) => setConn(s));
  peer.on('open', async () => {
    connected = true;
    setConn('connected');
    setProgress(1);
    setSound('Paired ✓');
    try { sonic?.destroy(); } catch { /* noop */ }
    try { sonicTx?.destroy(); } catch { /* noop */ }
    toClient('Loading models on iPhone…');
    log('Loading Whisper + Gemma-4…');
    try {
      const { env } = await import('@huggingface/transformers');
      env.backends.onnx.wasm.numThreads = 1; // Whisper (ORT) without SharedArrayBuffer
      const { Tutor } = await import('./llm.js');
      const { SpeechToText } = await import('./asr.js');
      tutor = new Tutor();
      stt = new SpeechToText();
      await stt.load(() => {});
      await tutor.load((p) => {
        if (p.status === 'progress') log(`Loading Gemma-4 — ${(p.progress || 0).toFixed(0)}%`);
      });
      log('Ready.'); toClient('Ready — say or type something in Arabic!');
    } catch (e) {
      log('Model load failed: ' + (e?.message || e));
      toClient('Gateway failed to load the model — see iPhone.');
      console.error(e);
    }
  });

  // Client → gateway.
  peer.on('control', async (m) => {
    if (m.type === 'dialect') { tutor?.setDialect(m.value); }
    else if (m.type === 'text') {
      if (!tutor) { toClient('Still loading the model on the iPhone…'); return; }
      tutor.setDialect(m.dialect || tutor.dialect); await respond(m.text);
    }
  });
  peer.on('audio', async (blob) => {
    if (!stt) { toClient('Still loading the model on the iPhone…'); return; }
    log('Transcribing…');
    const text = await stt.transcribeBlob(blob);
    if (!text) { toClient('Didn\u2019t catch that — try again.'); return; }
    peer.send({ type: 'transcript', text }); // echo recognized speech to the client
    await respond(text);
  });

  // Run the model and stream the reply back over the tokens channel.
  async function respond(text) {
    if (busy) return;
    busy = true;
    try {
      const { parseReply } = await import('./llm.js');
      log('Thinking…');
      const full = await tutor.reply(text, (partial) => {
        peer.sendToken({ type: 'partial', text: partial, parsed: parseReply(partial) });
      });
      peer.sendToken({ type: 'final', text: full, parsed: parseReply(full) });
      log('Ready.');
    } catch (e) {
      peer.sendToken({ type: 'final', text: 'Error: ' + (e?.message || e), parsed: null });
      console.error(e);
    } finally { busy = false; }
  }
}

// ---------- boot ----------
if (!hasRole) {
  // Opened without a role → let the user pick one cleanly.
  $('role-picker').classList.remove('hidden');
  $('pick-gateway').addEventListener('click', () => { location.search = '?role=gateway'; });
  $('pick-client').addEventListener('click', () => { location.search = '?role=client'; });
} else {
  (role === 'gateway' ? initGateway : initClient)().catch((e) => {
    console.error(e);
    setConn('error: ' + (e?.message || e));
  });
}
