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
function setSound(t) { const el = $('sound-status'); if (el) el.textContent = t; }
function sonicReset() { try { sonic?.destroy(); } catch { /* noop */ } sonic = new SonicLink(); }

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
    let received = false;
    try {
      await sonic.startListening(async (bytes) => {
        if (received || connected) return;
        try {
          await peer.acceptAnswer(packedToBlob(bytes));
          received = true; setSound('Heard the iPhone — connecting…'); setConn('connecting…');
        } catch { /* probably heard our own offer; keep listening */ }
      });
      setSound('Hold the phone close. Emitting offer + listening…');
      await sonic.sendUntil(blobToPacked(offerBlob), () => received || connected, { maxRepeats: 6 });
      if (!received && !connected) setSound('Still listening for the iPhone’s reply…');
    } catch (e) { setSound('Microphone/audio blocked: ' + (e?.message || e)); }
  });

  peer.on('state', (s) => setConn(s));
  peer.on('open', () => {
    connected = true;
    try { sonic?.destroy(); } catch { /* noop */ }
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
    let gotOffer = false;
    try {
      await sonic.startListening(async (bytes) => {
        if (gotOffer || connected) return;
        try {
          const answer = await peer.createAnswer(packedToBlob(bytes));
          gotOffer = true; sonic.stopListening();
          showLocalSignal(answer);
          setSound('Heard the Quest — replying over sound…'); setConn('connecting…');
          await sonic.sendUntil(blobToPacked(answer), () => connected);
        } catch { /* heard noise or our own audio; keep listening */ }
      });
      setSound('Hold the phone close to the headset. Listening for the Quest…');
    } catch (e) { setSound('Microphone/audio blocked: ' + (e?.message || e)); }
  });

  peer.on('state', (s) => setConn(s));
  peer.on('open', async () => {
    connected = true;
    setConn('connected');
    setSound('Paired ✓');
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
