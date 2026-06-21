// tts.js — Speaks the tutor's Arabic reply using the browser's Web Speech API,
// and pulses the avatar's mouth on each word boundary for lip-sync.

const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) ||
  (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent);

export class Speaker {
  constructor() {
    this.voice = null;
    this._unlocked = false;
    this._warm = false;       // iOS: synth kept perpetually active after unlock
    this._warmTimer = null;   // fallback re-prime timer
    this.ready = this._pickVoice();
  }

  _pickVoice() {
    return new Promise((resolve) => {
      let done = false;
      const choose = () => {
        if (done) return;
        const voices = speechSynthesis.getVoices();
        if (!voices.length) return; // wait for onvoiceschanged / timeout
        done = true;
        // Prefer a Levantine/Palestinian-ish voice, else any Arabic voice.
        this.voice =
          voices.find((v) => /ar[-_](PS|JO|LB|SY)/i.test(v.lang)) ||
          voices.find((v) => /^ar(\b|[-_])/i.test(v.lang)) ||
          null;
        resolve();
      };
      choose();
      if (!done) {
        speechSynthesis.onvoiceschanged = choose;
        // iOS sometimes never fires onvoiceschanged; don't hang forever.
        setTimeout(() => { if (!done) { done = true; resolve(); } }, 1500);
      }
    });
  }

  // Re-query voices in case they loaded after construction (common on iOS).
  _ensureVoice() {
    if (this.voice) return;
    const voices = speechSynthesis.getVoices();
    this.voice =
      voices.find((v) => /ar[-_](PS|JO|LB|SY)/i.test(v.lang)) ||
      voices.find((v) => /^ar(\b|[-_])/i.test(v.lang)) ||
      null;
  }

  get hasArabicVoice() { this._ensureVoice(); return !!this.voice; }

  // iOS Safari refuses to speak unless speechSynthesis was first invoked from
  // inside a user gesture, AND that permission only lasts a brief window after
  // the gesture — once the synth goes idle it re-locks, so a reply arriving
  // 5–30s later (after the gateway responds) is silently dropped. To survive
  // that gap we keep the synth perpetually "warm": after the first gesture we
  // chain near-silent utterances so it never goes idle and out-of-gesture
  // replies can always queue onto a live synth. Call this from a tap/click.
  unlock() {
    try {
      speechSynthesis.resume();
      this._unlocked = true;
      if (IS_IOS) {
        this._startWarm();
      } else if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        // Desktop just needs a one-shot prime.
        const u = new SpeechSynthesisUtterance('\u200b');
        u.volume = 0.01;
        u.rate = 10;
        speechSynthesis.speak(u);
      }
    } catch { /* noop */ }
  }

  // Begin (or re-assert) the perpetual silent loop that keeps iOS's synth
  // permission alive. Must be kicked off from inside a user gesture.
  _startWarm() {
    speechSynthesis.resume();
    if (this._warm) return;
    this._warm = true;
    this._queueSilent();
  }

  // Speak one near-silent utterance and re-queue another when it finishes, so
  // `speechSynthesis.speaking` stays true indefinitely. A real reply spoken
  // out-of-gesture then queues right behind the current silent chunk and plays.
  _queueSilent() {
    if (!this._warm) return;
    try {
      speechSynthesis.resume();
      const s = new SpeechSynthesisUtterance('\u200b'); // zero-width space
      s.volume = 0;
      s.rate = 1;
      const next = () => {
        if (!this._warm) return;
        // Re-queue on the next tick so we don't tight-loop if it ends instantly.
        this._warmTimer = setTimeout(() => this._queueSilent(), 250);
      };
      s.onend = next;
      s.onerror = next;
      speechSynthesis.speak(s);
    } catch { /* noop */ }
  }

  // Speaks `text`. Callbacks: onStart, onBoundary (per word), onEnd.
  async speak(text, { onStart, onBoundary, onEnd } = {}) {
    // Don't let a stuck voices-promise block speech indefinitely.
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 1500))]);
    this._ensureVoice();

    // On iOS, if we're warm, do NOT cancel — cancel() drops the synth to idle
    // and a fresh out-of-gesture speak() is silently ignored. Just queue the
    // reply onto the already-active synth (it plays right after the current
    // silent chunk). On desktop, cancel to interrupt any previous utterance.
    if (!(IS_IOS && this._warm)) speechSynthesis.cancel();
    // iOS parks the synth in a paused state; without resume() speak() is silent.
    speechSynthesis.resume();

    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      // Force an Arabic locale so the engine reads the script correctly even if
      // we couldn't match a named voice.
      u.lang = this.voice?.lang || 'ar-SA';
      if (this.voice) u.voice = this.voice;
      u.rate = 0.9;   // a touch slower for learners
      u.pitch = 1.0;

      const finish = () => {
        onEnd?.();
        resolve();
      };
      u.onstart = () => onStart?.();
      u.onboundary = () => onBoundary?.();
      u.onend = finish;
      u.onerror = finish;

      speechSynthesis.speak(u);
      // Ensure the warm loop is running so this (and future) replies stay alive.
      if (IS_IOS && this._warm) this._queueSilent();
    });
  }

  stop() {
    // Stop the audible reply but keep the synth warm so the next out-of-gesture
    // reply can still play. Stopping warm entirely would re-lock iOS speech.
    speechSynthesis.cancel();
    if (IS_IOS && this._warm) {
      speechSynthesis.resume();
      this._queueSilent();
    }
  }
}
