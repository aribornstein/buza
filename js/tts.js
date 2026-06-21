// tts.js — Speaks the tutor's Arabic reply using the browser's Web Speech API,
// and pulses the avatar's mouth on each word boundary for lip-sync.

const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) ||
  (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent);

export class Speaker {
  constructor() {
    this.voice = null;
    this._unlocked = false;
    this._keepAlive = null;
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
  // inside a user gesture. Call this from a tap/click once so later
  // network-triggered replies are allowed to play. We speak a real (near-silent)
  // utterance — a volume:0 one does NOT reliably grant permission on iOS.
  unlock() {
    try {
      speechSynthesis.resume();
      // Don't disturb a reply that's already playing.
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance('\u200b'); // zero-width space
      u.volume = 0.01;
      u.rate = 10; // finish instantly
      speechSynthesis.speak(u);
      this._unlocked = true;
    } catch { /* noop */ }
  }

  // Speaks `text`. Callbacks: onStart, onBoundary (per word), onEnd.
  async speak(text, { onStart, onBoundary, onEnd } = {}) {
    // Don't let a stuck voices-promise block speech indefinitely.
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 1500))]);
    this._ensureVoice();

    speechSynthesis.cancel();
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
        this._stopKeepAlive();
        onEnd?.();
        resolve();
      };
      u.onstart = () => onStart?.();
      u.onboundary = () => onBoundary?.();
      u.onend = finish;
      u.onerror = finish;

      speechSynthesis.speak(u);
      // iOS suspends long utterances after ~15s; nudge it to keep going.
      if (IS_IOS) this._startKeepAlive();
    });
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAlive = setInterval(() => {
      if (speechSynthesis.speaking) { speechSynthesis.pause(); speechSynthesis.resume(); }
      else this._stopKeepAlive();
    }, 8000);
  }

  _stopKeepAlive() {
    if (this._keepAlive) { clearInterval(this._keepAlive); this._keepAlive = null; }
  }

  stop() { this._stopKeepAlive(); speechSynthesis.cancel(); }
}
