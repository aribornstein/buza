// main.js — Orchestrates the whole tutor: UI, avatar, Whisper STT, Gemma chat,
// and Arabic TTS. Pipeline:  mic → Whisper → Gemma → TTS + avatar lip-sync.

import { env } from '@huggingface/transformers';
import { Avatar } from './avatar.js';
import { SpeechToText } from './asr.js';
import { Tutor, parseReply } from './llm.js';
import { Speaker } from './tts.js';

// Whisper (speech-to-text) runs on Transformers.js, which defaults to the
// MULTI-THREADED ONNX Runtime wasm build — that needs SharedArrayBuffer, only
// available on cross-origin-isolated pages (COOP/COEP headers). Served without
// those headers, the threaded runtime aborts during init with an opaque numeric
// error. Forcing single-threaded mode removes that requirement. (The Gemma-4
// model uses its own WebGPU runtime and is unaffected.)
env.backends.onnx.wasm.numThreads = 1;

// ----- DOM -----
const $ = (id) => document.getElementById(id);
const statusDot = $('status-dot');
const statusText = $('status-text');
const transcript = $('transcript');
const loader = $('loader');
const progressBar = $('progress-bar');
const loaderDetail = $('loader-detail');
const loadBtn = $('load-btn');
const micBtn = $('mic-btn');
const sendBtn = $('send-btn');
const textInput = $('text-input');
const composer = $('composer');
const dialectSelect = $('dialect-select');
const speakToggle = $('speak-toggle');

// ----- Modules -----
const avatar = new Avatar($('avatar-canvas'));
const stt = new SpeechToText();
const tutor = new Tutor();
const speaker = new Speaker();

let loaded = false;
let busy = false;
let recording = false;
let forceLocalLoad = false; // set after a preflight warning so a 2nd click overrides

// The Gemma-4 E2B weights are ~2GB once on the GPU. iOS/iPadOS Safari caps the
// WebGPU process memory well below that (observed OOM ≈1.3GB on a device whose
// maxBufferSize is 1024MB), so the standalone path can't hold the model there.
// We use maxBufferSize as a proxy for the device's GPU memory budget.
const MODEL_GPU_BYTES = 2.0 * 1024 * 1024 * 1024;


function setStatus(state, text) {
  statusDot.className = state;
  statusText.textContent = text;
}

function addMessage(role, content) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  transcript.appendChild(el);
  if (content) el.textContent = content;
  transcript.scrollTop = transcript.scrollHeight;
  return el;
}

function renderTutorMessage(el, { ar, tr, en }) {
  el.innerHTML = '';
  if (ar) { const d = document.createElement('div'); d.className = 'ar'; d.dir = 'rtl'; d.textContent = ar; el.appendChild(d); }
  if (tr) { const d = document.createElement('div'); d.className = 'translit'; d.textContent = tr; el.appendChild(d); }
  if (en) { const d = document.createElement('div'); d.className = 'en'; d.textContent = en; el.appendChild(d); }
  transcript.scrollTop = transcript.scrollHeight;
}

// ----- Model loading -----
const progress = {};
function onProgress(p) {
  if (p.status === 'progress' && p.file) {
    progress[p.file] = p.progress || 0;
    const vals = Object.values(progress);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    progressBar.style.width = `${avg.toFixed(0)}%`;
    loaderDetail.textContent = `${p.file} — ${(p.progress || 0).toFixed(0)}%`;
  } else if (p.status === 'ready' || p.status === 'done') {
    loaderDetail.textContent = 'Initializing…';
  }
}

async function loadEverything() {
  if (loaded) return;
  if (!('gpu' in navigator)) {
    setStatus('idle', 'WebGPU not available — use Chrome/Edge 121+ or enable WebGPU.');
    addMessage('system', '⚠️ This app needs WebGPU. Please open it in a recent Chrome or Edge browser.');
    return;
  }
  loadBtn.disabled = true;
  loader.classList.remove('hidden');
  setStatus('loading', 'Loading models…');

  // On-device WebGPU diagnostics: surfaces device-lost / OOM reasons and a crash
  // trail that survives a tab reload (an iOS OOM kill wipes the console).
  let diag = { emit() {}, stage() {} };
  let gpuLimits = null;
  try {
    const { installGpuDiagnostics, probeWebGPU } = await import('./gpu-diag.js');
    diag = installGpuDiagnostics({ showPanel: true });
    diag.stage('probe WebGPU');
    const probe = await probeWebGPU(diag.emit);
    gpuLimits = probe?.limits || null;
  } catch (e) { console.warn('diag unavailable', e); }

  // Preflight: bail out before the doomed ~2GB download on a GPU that can't hold
  // the model (iOS/iPadOS Safari). A first click warns + offers companion mode;
  // a second click forces the attempt anyway.
  const maxBuf = Number(gpuLimits?.maxBufferSize) || 0;
  if (maxBuf && maxBuf < MODEL_GPU_BYTES * 1.1 && !forceLocalLoad) {
    const mb = Math.round(maxBuf / 1048576);
    diag.emit(`PREFLIGHT: maxBufferSize ${mb}MB < model ~2GB — standalone won't fit on this GPU`);
    diag.stage('preflight: insufficient GPU memory');
    loader.classList.add('hidden');
    loadBtn.disabled = false;
    forceLocalLoad = true; // allow a second Load click to override
    $('mode-picker')?.classList.remove('hidden');
    setStatus('idle', 'This device’s GPU is too small to run the model locally.');
    addMessage('system', `⚠️ This device’s GPU memory (~${mb}MB) is too small to run the ~2GB model on its own — it crashes partway through loading. Use a companion device: keep this device as a light client and let a laptop/desktop run the AI. (Or tap Load again to try anyway.)`);
    return;
  }

  try {
    diag.stage('load Gemma-4 weights + warmup');
    loaderDetail.textContent = 'Loading the language model (Gemma 4)…';
    await tutor.load(onProgress, { limits: gpuLimits, emit: diag.emit });
    diag.stage('load Whisper');
    loaderDetail.textContent = 'Loading speech recognition (Whisper)…';
    await stt.load(onProgress);
    await speaker.ready;
    diag.stage('ready');

    loaded = true;
    loader.classList.add('hidden');
    setStatus('ready', 'Ready — say or type something in Arabic!');
    enableInputs(true);
    if (!speaker.hasArabicVoice) {
      addMessage('system', 'ℹ️ No Arabic system voice found, so spoken replies may use a default voice. (Install an Arabic voice in your OS for best results.)');
    }
    greet();
  } catch (err) {
    console.error(err);
    diag.emit('LOAD FAILED: ' + (err?.message || err));
    diag.stage('FAILED');
    loader.classList.add('hidden');
    loadBtn.disabled = false;
    setStatus('idle', 'Failed to load models — see console.');
    const detail = err?.message || (typeof err === 'number' ? `runtime error code ${err}` : String(err));
    addMessage('system', `⚠️ Loading failed: ${detail}`);
  }
}

function enableInputs(on) {
  micBtn.disabled = !on;
  sendBtn.disabled = !on;
  textInput.disabled = !on;
}

async function greet() {
  await handleUserText('مرحبا! أنا جاهز أتعلّم.', { silentUser: true });
}

// ----- Core turn handling -----
async function handleUserText(text, { silentUser = false } = {}) {
  if (!text || busy) return;
  busy = true;
  enableInputs(false);

  if (!silentUser) addMessage('user', text);

  setStatus('thinking', 'Thinking…');
  const tutorEl = addMessage('tutor', '…');

  let finalText = '';
  try {
    finalText = await tutor.reply(text, (partial) => {
      const parsed = parseReply(partial);
      renderTutorMessage(tutorEl, parsed.ar || parsed.tr || parsed.en ? parsed : { ar: partial });
    });
  } catch (err) {
    console.error(err);
    tutorEl.textContent = `⚠️ ${err.message}`;
    busy = false;
    enableInputs(true);
    setStatus('ready', 'Ready');
    return;
  }

  const parsed = parseReply(finalText);
  renderTutorMessage(tutorEl, parsed);

  // Speak the Arabic line and lip-sync the avatar.
  if (speakToggle.checked && parsed.ar) {
    setStatus('speaking', 'Speaking…');
    avatar.setSpeaking(true);
    await speaker.speak(parsed.ar, {
      onBoundary: () => avatar.pulse(1),
      onEnd: () => avatar.setSpeaking(false),
    });
    avatar.setSpeaking(false);
  }

  busy = false;
  enableInputs(true);
  setStatus('ready', 'Ready — your turn!');
}

// ----- Mic (press & hold or click to toggle) -----
async function startRecording() {
  if (!loaded || busy || recording) return;
  recording = true;
  micBtn.classList.add('recording');
  setStatus('listening', 'Listening… (click again to stop)');
  speaker.stop();
  try {
    await stt.startRecording();
  } catch (err) {
    recording = false;
    micBtn.classList.remove('recording');
    setStatus('ready', 'Mic permission denied.');
    addMessage('system', '⚠️ Could not access the microphone.');
  }
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove('recording');
  setStatus('thinking', 'Transcribing…');
  try {
    const text = await stt.stopAndTranscribe();
    if (text) await handleUserText(text);
    else { setStatus('ready', 'Didn’t catch that — try again.'); }
  } catch (err) {
    console.error(err);
    setStatus('ready', 'Transcription failed.');
  }
}

// ----- Wire up events -----
loadBtn.addEventListener('click', loadEverything);

micBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  handleUserText(text);
});

dialectSelect.addEventListener('change', () => {
  tutor.setDialect(dialectSelect.value);
  addMessage('system', dialectSelect.value === 'palestinian'
    ? 'Switched to Palestinian colloquial.'
    : 'Switched to Modern Standard Arabic.');
});

speakToggle.addEventListener('change', () => { if (!speakToggle.checked) speaker.stop(); });

// ----- Startup mode picker: run locally or offload to a companion device -----
const modePicker = $('mode-picker');
$('opt-local').addEventListener('click', () => {
  modePicker.classList.add('hidden');
  loadEverything();
});
$('opt-client').addEventListener('click', () => {
  location.href = './companion.html?role=client';
});
$('opt-gateway').addEventListener('click', () => {
  location.href = './companion.html?role=gateway';
});

// If a previous run crashed mid-load (e.g. an iOS WebGPU OOM tab-kill that
// reloads the page), surface that crash trail immediately so it isn't lost.
import('./gpu-diag.js').then((m) => m.replayPrevious()).catch(() => {});

setStatus('idle', 'Choose where the AI runs to begin');
