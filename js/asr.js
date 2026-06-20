// asr.js — Speech-to-text with Whisper running in the browser via Transformers.js.
// Captures microphone audio, decodes it to a 16 kHz mono Float32Array, and
// transcribes it (forced to Arabic).

import { pipeline } from '@huggingface/transformers';

const SAMPLE_RATE = 16000;

export class SpeechToText {
  constructor() {
    this.transcriber = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
  }

  async load(onProgress) {
    // whisper-base is multilingual and small enough for the browser.
    this.transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-base',
      { device: 'webgpu', dtype: 'fp32', progress_callback: onProgress }
    );
  }

  async startRecording() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
  }

  // Stops recording, decodes audio and returns the transcribed Arabic text.
  async stopAndTranscribe() {
    if (!this.mediaRecorder) return '';
    const done = new Promise((resolve) => {
      this.mediaRecorder.onstop = resolve;
    });
    this.mediaRecorder.stop();
    await done;
    this.stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
    const audio = await this._decodeToMono16k(blob);
    if (audio.length < SAMPLE_RATE * 0.3) return ''; // too short, ignore

    const out = await this.transcriber(audio, {
      language: 'arabic',
      task: 'transcribe',
      chunk_length_s: 30,
    });
    return (out?.text || '').trim();
  }

  // Transcribes an audio clip that was recorded elsewhere (e.g. arrived over a
  // WebRTC data channel from the companion client). Same pipeline as above,
  // minus the local recording step.
  async transcribeBlob(blob) {
    const audio = await this._decodeToMono16k(blob);
    if (audio.length < SAMPLE_RATE * 0.3) return ''; // too short, ignore
    const out = await this.transcriber(audio, {
      language: 'arabic',
      task: 'transcribe',
      chunk_length_s: 30,
    });
    return (out?.text || '').trim();
  }

  async _decodeToMono16k(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    await ctx.close();

    // Downmix to mono
    const channels = decoded.numberOfChannels;
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }

    // Resample to 16 kHz with the OfflineAudioContext
    if (decoded.sampleRate === SAMPLE_RATE) return mono;
    const offline = new OfflineAudioContext(1, Math.ceil(length * SAMPLE_RATE / decoded.sampleRate), SAMPLE_RATE);
    const buffer = offline.createBuffer(1, length, decoded.sampleRate);
    buffer.copyToChannel(mono, 0);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }
}
