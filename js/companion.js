// companion.js — Drives the WebRTC companion experience for BOTH ends from one
// codebase, selected by ?role=:
//
//   ?role=gateway  → the gateway device. Runs Whisper + Gemma-4, streams replies.
//   ?role=client   → the client device (any browser). Thin client: mic + avatar + UI.
//                    Needs NO WebGPU — all heavy compute lives on the gateway.
//
// Signaling is manual (no server): each side shows a compact SDP blob (text +
// QR); the other side pastes or scans it. See rtc.js for the wire format.

import { RTCPeer, packedToBlob, blobToPacked } from './rtc.js';
import { SonicLink } from './sonic.js';
import { StopWaitARQ } from './arq.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roleParam = params.get('role');
const hasRole = roleParam === 'gateway' || roleParam === 'client';
const role = roleParam === 'gateway' ? 'gateway' : 'client';

if (hasRole) {
  document.body.dataset.role = role;
  $('role-badge').textContent = role === 'gateway' ? 'Gateway device' : 'Client device';
}

// Data-over-sound pairing — shared across roles. Lets the two devices swap
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
// Reliable acoustic pairing uses Stop-and-Wait ARQ (see arq.js): the client
// delivers its offer and the gateway delivers its answer, each retransmitting
// until the other side acknowledges. The ARQ's own ACK is the "I got it, you can
// stop" signal, so the channel hands off cleanly without any ad-hoc beeps.

// Derive a safe retransmission timeout from the codec's symbol air-time. An ACK
// is one short frame; the RTO just has to outlast one round-trip (ack air-time +
// turnaround), so we add a generous margin.
function arqRto(link) { return link.airtimeMs(1) + 2500; }

const mbStr = (n) => (typeof n === 'number' ? (n / 1048576).toFixed(0) + 'MB' : '?');

// iOS: speaking a reply forces the audio session to 'playback' (output-only),
// which then blocks mic capture. Call this right before any getUserMedia (sonic
// pairing or push-to-talk) to hand the mic back. No-op where unsupported / not
// previously forced to playback.
function allowMicAudioSession() {
  try {
    const s = navigator.audioSession;
    if (s && s.type === 'playback') s.type = 'play-and-record';
  } catch { /* noop */ }
}

// Re-encode a recorded clip into a 16 kHz mono WAV. The client records WebM/Opus
// (e.g. on Chrome), which some gateway browsers (notably iOS Safari) cannot
// decode. Decoding happens here, in the browser that produced the clip, and the WAV we
// emit decodes cleanly everywhere.
async function blobToWav16k(blob) {
  const SR = 16000;
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ac.decodeAudioData(await blob.arrayBuffer()); }
  finally { ac.close().catch(() => {}); }

  const len = decoded.length;
  let mono = new Float32Array(len);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / decoded.numberOfChannels;
  }
  if (decoded.sampleRate !== SR) {
    const off = new OfflineAudioContext(1, Math.ceil(len * SR / decoded.sampleRate), SR);
    const buf = off.createBuffer(1, len, decoded.sampleRate);
    buf.copyToChannel(mono, 0);
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    mono = (await off.startRendering()).getChannelData(0);
  }
  return encodeWavPcm16(mono, SR);
}

// Wrap mono Float32 samples in a 16-bit PCM WAV container.
function encodeWavPcm16(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                 // PCM
  view.setUint16(22, 1, true);                 // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);    // byte rate
  view.setUint16(32, 2, true);                 // block align
  view.setUint16(34, 16, true);                // bits/sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

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

// Optional camera-based QR scanner (works where camera is granted).
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

// ============================================================ CLIENT (client device)
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
    $('signal-title').textContent = '1) Show this to the gateway device  ·  2) paste its reply below';
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

  // On-screen TTS debug overlay (iOS has no console). Always on for now while we
  // chase the no-audio bug; the version stamp confirms which code is running.
  const TTS_BUILD = 'tts-debug-2026-06-21i';
  let ttsLogEl = null;
  const ttsLines = [];
  const ttsDebug = (msg) => {
    const t = new Date().toISOString().slice(11, 23);
    ttsLines.unshift(`${t}  ${msg}`);
    if (ttsLines.length > 100) ttsLines.pop();
    if (!ttsLogEl) mountTtsPanel();
    if (ttsLogEl && !ttsLogEl._collapsed) ttsLogEl.textContent = ttsLines.join('\n');
  };
  function mountTtsPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;right:6px;bottom:6px;z-index:9999;width:min(82vw,340px);' +
      'font:11px/1.3 ui-monospace,Menlo,monospace;background:#0b1020f2;color:#d6e2ff;' +
      'border:1px solid #2a3a66;border-radius:8px;box-shadow:0 2px 10px #0008;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:5px 7px;border-bottom:1px solid #2a3a66;';
    const title = document.createElement('span');
    title.textContent = 'TTS log';
    title.style.cssText = 'flex:1;font-weight:600;opacity:.85;';
    const mkBtn = (label) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:11px ui-monospace,monospace;padding:3px 7px;border:1px solid #3a4a7a;' +
        'border-radius:6px;background:#1b2547;color:#d6e2ff;cursor:pointer;';
      return b;
    };
    const copyBtn = mkBtn('copy'), clearBtn = mkBtn('clear'), hideBtn = mkBtn('–');
    const testBtn = mkBtn('🔊test');
    const body = document.createElement('div');
    body.style.cssText = 'max-height:26vh;overflow:auto;white-space:pre-wrap;padding:6px 7px;';
    bar.append(title, testBtn, copyBtn, clearBtn, hideBtn);
    wrap.append(bar, body);
    document.body.appendChild(wrap);
    ttsLogEl = body;
    ttsLogEl._collapsed = false;
    // Speak from a DIRECT tap inside this page. If this is silent too, the issue
    // is environmental (audio session muted by the mic), not the gesture window.
    testBtn.addEventListener('click', () => {
      ttsDebug(`🔊test tap: synth(speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending} paused=${speechSynthesis.paused})`);
      speaker?.speak('مَرحَبا، هَذا اختِبار', {
        onStart: () => ttsDebug('🔊test ▶ onStart'),
        onEnd: () => ttsDebug('🔊test ✓ onEnd'),
        onError: (e) => ttsDebug('🔊test ❌ onError: ' + (e?.error || e)),
      });
    });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(ttsLines.join('\n')); copyBtn.textContent = 'copied'; }
      catch { /* select fallback */ const r = document.createRange(); r.selectNodeContents(body);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); copyBtn.textContent = 'select+copy'; }
      setTimeout(() => (copyBtn.textContent = 'copy'), 1200);
    });
    clearBtn.addEventListener('click', () => { ttsLines.length = 0; body.textContent = ''; });
    hideBtn.addEventListener('click', () => {
      ttsLogEl._collapsed = !ttsLogEl._collapsed;
      body.style.display = ttsLogEl._collapsed ? 'none' : '';
      hideBtn.textContent = ttsLogEl._collapsed ? '+' : '–';
      if (!ttsLogEl._collapsed) body.textContent = ttsLines.join('\n');
    });
  }
  ttsDebug(`build=${TTS_BUILD} speaker=${!!speaker} iosVoice=${speaker?.hasArabicVoice}`);
  ttsDebug(`audioSession=${navigator.audioSession ? navigator.audioSession.type : 'unsupported'}`);

  // iOS Safari blocks speech until it's first triggered inside a user gesture,
  // and can re-pause the synth later. Re-assert on every tap (unlock() is a
  // cheap no-op once primed and won't interrupt a reply that's playing).
  const unlockTTS = () => {
    speaker?.unlock();
    ttsDebug(`tap → unlock() synth.speaking=${speechSynthesis.speaking} audioSession=${navigator.audioSession?.type || 'n/a'}`);
  };
  window.addEventListener('pointerdown', unlockTTS);

  // 3) Accept the gateway's answer.
  $('apply-remote').addEventListener('click', async () => {
    const blob = $('remote-blob').value.trim();
    if (!blob) return;
    try { await peer.acceptAnswer(blob); setConn('connecting…'); }
    catch (e) { setConn('bad code'); console.error(e); }
  });

  // 3b) Or pair entirely over sound, reliably, using Stop-and-Wait ARQ. The
  //     client is the ARQ initiator: it delivers its offer (retransmitting until
  //     the gateway ACKs), then listens for the gateway's answer (which the ARQ
  //     auto-ACKs). The ARQ's ACK is the clean "stop transmitting" hand-off.
  $('sound-btn').addEventListener('click', async () => {
    if (!offerBlob) { setSound('No pairing code yet — reload the page.'); return; }
    sonicReset();
    // ggwave can't encode and decode on one instance at the same time, so the
    // client listens on `sonic` and emits on a separate `sonicTx`.
    sonicTx = new SonicLink();
    setProgress(0);
    let received = false;
    const waitUntil = (cond, ms) => new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (cond() || Date.now() - t0 >= ms) { clearInterval(iv); resolve(); }
      }, 120);
    });
    try {
      await sonic.init();
      await sonicTx.init();
      allowMicAudioSession(); // iOS: ensure the mic isn't locked out by a prior 'playback'
      const arq = new StopWaitARQ({ send: (b, p) => sonicTx.send(b, p), role: 0, rtoMs: arqRto(sonicTx) });
      arq.onData = async (payload) => { // the gateway's answer arrived (and was auto-ACKed)
        if (received || connected) return;
        try {
          await peer.acceptAnswer(packedToBlob(payload));
          received = true; setProgress(1); setSound('Heard the gateway — connecting…'); setConn('connecting…');
        } catch { /* not a valid answer; keep listening */ }
      };
      await sonic.startListening((raw) => arq.feed(raw), ({ fraction, receivedBytes, totalBytes }) => {
        if (received || connected) return;
        setProgress(fraction);
        setSound(totalBytes ? `Hearing the gateway’s reply… ${receivedBytes}/${totalBytes} B` : 'Listening for the gateway…');
      });
      setSound('Hold the phone close — pairing over sound…');
      const sent = await arq.deliver(blobToPacked(offerBlob), ({ fraction, sentBytes, totalBytes }) => {
        if (!received && !connected) { setProgress(fraction); setSound(`Emitting offer… ${sentBytes}/${totalBytes} B`); }
      });
      if (!sent && !received && !connected) {
        setProgress(null); setSound('No reply heard — move the phone closer and tap again.'); return;
      }
      // Offer acknowledged: the gateway now owns the channel. Just listen for the
      // answer (the ARQ delivers + auto-ACKs it via arq.onData above).
      setProgress(0); setSound('Gateway got the code — listening for its reply…');
      await waitUntil(() => received || connected, 40000);
      if (!received && !connected) setSound('No reply heard — move the phone closer and tap again.');
    } catch (e) { setProgress(null); setSound('Microphone/audio blocked: ' + (e?.message || e)); }
  });

  peer.on('state', (s) => setConn(s));
  peer.on('open', () => {
    connected = true;
    setProgress(1);
    try { sonic?.destroy(); } catch { /* noop */ }
    try { sonicTx?.destroy(); } catch { /* noop */ }
    // Pairing held the mic (record session); now that it's released, switch to
    // output mode ahead of the first reply so iOS has the route settled by the
    // time we speak (a category switch *during* speak() drops the utterance).
    speaker?.claimOutput();
    ttsDebug(`open → claimOutput audioSession=${navigator.audioSession?.type || 'n/a'}`);
    $('signal-panel').classList.add('hidden');
    $('app-panel').classList.remove('hidden');
    playWelcome();
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
      const ar = m.parsed?.ar || '';
      ttsDebug(`final: speaker=${!!speaker} toggle=${$('speak-toggle').checked} arLen=${ar.length} ` +
        `synth(speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending} paused=${speechSynthesis.paused})`);
      if (speaker && $('speak-toggle').checked && ar) {
        ttsDebug('→ calling speaker.speak()');
        speaker.speak(ar, {
          onStart: () => ttsDebug('▶ onStart'),
          onBoundary: () => avatar?.pulse(1),
          onEnd: () => ttsDebug('✓ onEnd'),
          onError: (e) => ttsDebug('❌ onError: ' + (e?.error || e)),
        });
        setTimeout(() => ttsDebug(`+300ms synth(speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending} paused=${speechSynthesis.paused}) audioSession=${navigator.audioSession?.type || 'n/a'}`), 300);
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
    allowMicAudioSession(); // iOS: undo any prior 'playback' lock so the mic works
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
    // Mic is released; hand the audio session back to output mode now so the
    // route is settled before the gateway's spoken reply arrives.
    speaker?.claimOutput();
    const blob = new Blob(chunks, { type: recorder.mimeType });
    recorder = null; micBtn.classList.remove('recording'); setStatus('Transcribing on the gateway…');
    peer.send({ type: 'dialect', value: $('dialect-select').value });
    // The client (e.g. Chrome) records WebM/Opus, which some gateway browsers
    // (notably iOS Safari) cannot decode. Re-encode here — where the recording
    // can be decoded — into a 16 kHz mono WAV that Whisper reads cleanly.
    let outBlob = blob;
    try { outBlob = await blobToWav16k(blob); }
    catch (e) { console.warn('WAV transcode failed, sending raw clip:', e); }
    await peer.sendAudio(outBlob);
  };
  micBtn.addEventListener('pointerdown', startRec);
  micBtn.addEventListener('pointerup', stopRec);
  micBtn.addEventListener('pointerleave', stopRec);

  // ---- client DOM helpers ----
  function enableComposer(on) {
    $('mic-btn').disabled = !on; $('send-btn').disabled = !on; $('text-input').disabled = !on;
  }
  function setStatus(t) { $('status-text').textContent = t; }

  // On connect, greet the learner out loud BEFORE enabling input. Besides being
  // friendly, speaking here "warms" the iOS audio route right after the session
  // switches to playback, so the first real reply isn't the utterance that gets
  // dropped during the category change. The composer is re-enabled when the
  // greeting ends (or after a safety timeout, so input is never left disabled).
  let welcomed = false;
  function playWelcome() {
    if (welcomed) return;
    welcomed = true;
    const WELCOME = {
      ar: 'أهلاً وسهلاً! أنا معلّمك للعربي. يلّا نبدأ.',
      tr: "Ahlan wa sahlan! Ana mʿallmak lal-ʿarabi. Yalla nabda.",
      en: "Welcome! I'm your Arabic teacher. Let's begin.",
    };
    renderTutor(addMessage('tutor', ''), WELCOME);

    enableComposer(false);
    setStatus('Greeting you…');
    let enabled = false;
    const enable = () => {
      if (enabled) return;
      enabled = true;
      setStatus('Connected — say or type something in Arabic!');
      enableComposer(true);
    };

    if (speaker && $('speak-toggle').checked) {
      // claimOutput() just switched the session to playback; give the iOS audio
      // route a moment to settle before the utterance so it isn't dropped.
      setTimeout(() => {
        ttsDebug('welcome → speak()');
        speaker.speak(WELCOME.ar, {
          onStart: () => ttsDebug('welcome ▶ onStart'),
          onEnd: () => { ttsDebug('welcome ✓ onEnd'); enable(); },
          onError: (e) => { ttsDebug('welcome ❌ ' + (e?.error || e)); enable(); },
        });
        // Fallback: never leave the composer disabled if no speech events fire.
        setTimeout(enable, 6000);
      }, 500);
    } else {
      enable();
    }
  }
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

// ============================================================ GATEWAY (gateway device)
async function initGateway() {
  $('signal-title').textContent = '1) Scan / paste the client device\u2019s code  ·  2) show your reply back';
  $('apply-remote').textContent = 'Generate reply code';
  $('local-blob').placeholder = 'Your reply code appears here after you load the client device’s code.';
  // If a previous run crashed mid model-load (e.g. an iOS WebGPU OOM tab-kill),
  // surface that crash trail immediately so it isn't lost on the reload.
  import('./gpu-diag.js').then((m) => m.replayPrevious()).catch(() => {});
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

  // Answer the client device's offer.
  $('apply-remote').addEventListener('click', async () => {
    const blob = $('remote-blob').value.trim();
    if (!blob) return;
    try {
      const answer = await peer.createAnswer(blob);
      showLocalSignal(answer);
      $('signal-title').textContent = 'Show / send this reply code to the client device';
      setConn('connecting…');
    } catch (e) { setConn('bad code'); console.error(e); }
  });

  // Or pair over sound: listen for the client's offer, then emit our answer on a
  // loop until WebRTC opens. We stop listening once we have the offer so our own
  // answer chirp doesn't collide with itself on the mic.
  // Or pair over sound, reliably, using Stop-and-Wait ARQ. The gateway is the
  // ARQ responder: it listens for the client's offer (auto-ACKing it — that ACK
  // is what tells the client to stop transmitting), builds the answer, then
  // delivers the answer (retransmitting until the client ACKs).
  $('sound-btn').addEventListener('click', async () => {
    sonicReset();
    // The gateway listens on `sonic` and transmits on a separate `sonicTx`.
    sonicTx = new SonicLink();
    setProgress(0);
    let handled = false;
    try {
      await sonic.init();
      await sonicTx.init();
      const arq = new StopWaitARQ({ send: (b, p) => sonicTx.send(b, p), role: 1, rtoMs: arqRto(sonicTx) });
      arq.onData = async (payload) => { // the client's offer arrived (and was auto-ACKed)
        if (handled || connected) return;
        handled = true;
        try {
          const answer = await peer.createAnswer(packedToBlob(payload), { fastIce: true });
          showLocalSignal(answer);
          setConn('connecting…'); setProgress(0);
          const ok = await arq.deliver(blobToPacked(answer), ({ fraction, sentBytes, totalBytes }) => {
            if (!connected) { setProgress(fraction); setSound(`Replying over sound… ${sentBytes}/${totalBytes} B`); }
          });
          if (!ok && !connected) setSound('Client device didn’t confirm the reply — move it closer and try again.');
        } catch (e) { handled = false; setSound('Couldn’t build a reply: ' + (e?.message || e)); }
      };
      await sonic.startListening((raw) => arq.feed(raw), ({ fraction, receivedBytes, totalBytes }) => {
        if (!handled && !connected) { setProgress(fraction); setSound(totalBytes ? `Hearing the client device’s code… ${receivedBytes}/${totalBytes} B` : 'Listening for the client device…'); }
      });
      setSound('Hold the two devices close together. Listening for the client device…');
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
    toClient('Loading models on the gateway…');
    log('Loading Whisper + Gemma-4…');
    // On-device WebGPU diagnostics: surfaces device-lost / OOM reasons and a
    // crash trail that survives an iOS tab reload (no DevTools needed).
    let diag = { emit() {}, stage() {} };
    let gpuLimits = null;
    try {
      const { installGpuDiagnostics, probeWebGPU } = await import('./gpu-diag.js');
      diag = installGpuDiagnostics({ showPanel: true });
      diag.stage('probe WebGPU');
      const probe = await probeWebGPU(diag.emit);
      gpuLimits = probe?.limits || null;
    } catch (e) { console.warn('diag unavailable', e); }
    try {
      diag.stage('import @huggingface/transformers');
      const { env } = await import('@huggingface/transformers');
      env.backends.onnx.wasm.numThreads = 1; // Whisper (ORT) without SharedArrayBuffer
      diag.stage('import llm.js + asr.js');
      const { Tutor } = await import('./llm.js');
      const { SpeechToText } = await import('./asr.js');
      tutor = new Tutor();
      stt = new SpeechToText();
      diag.stage('load Whisper');
      await stt.load(() => {});
      diag.stage('load Gemma-4 weights + warmup');
      await tutor.load((p) => {
        if (p.status === 'progress') {
          const pct = (p.progress || 0).toFixed(0);
          log(`Loading Gemma-4 — ${pct}%`);
          if (p.totalBytes) diag.emit(`weights ${mbStr(p.loadedBytes)} / ${mbStr(p.totalBytes)} (${pct}%)`);
        }
      }, { limits: gpuLimits, emit: diag.emit });
      diag.stage('ready');
      log('Ready.'); toClient('Ready — say or type something in Arabic!');
    } catch (e) {
      diag.emit('LOAD FAILED: ' + (e?.message || e));
      diag.stage('FAILED');
      log('Model load failed: ' + (e?.message || e));
      toClient('Gateway failed to load the model — see the gateway device.');
      console.error(e);
    }
  });

  // Client → gateway.
  peer.on('control', async (m) => {
    if (m.type === 'dialect') { tutor?.setDialect(m.value); }
    else if (m.type === 'text') {
      if (!tutor) { toClient('Still loading the model on the gateway…'); return; }
      tutor.setDialect(m.dialect || tutor.dialect); await respond(m.text);
    }
  });
  peer.on('audio', async (blob) => {
    if (!stt) { toClient('Still loading the model on the gateway…'); return; }
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
