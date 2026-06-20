// tts.js — Speaks the tutor's Arabic reply using the browser's Web Speech API,
// and pulses the avatar's mouth on each word boundary for lip-sync.

export class Speaker {
  constructor() {
    this.voice = null;
    this.ready = this._pickVoice();
  }

  _pickVoice() {
    return new Promise((resolve) => {
      const choose = () => {
        const voices = speechSynthesis.getVoices();
        // Prefer a Levantine/Palestinian-ish voice, else any Arabic voice.
        this.voice =
          voices.find((v) => /ar[-_](PS|JO|LB|SY)/i.test(v.lang)) ||
          voices.find((v) => /^ar(\b|[-_])/i.test(v.lang)) ||
          null;
        resolve();
      };
      const voices = speechSynthesis.getVoices();
      if (voices.length) choose();
      else speechSynthesis.onvoiceschanged = choose;
    });
  }

  get hasArabicVoice() { return !!this.voice; }

  // iOS Safari (and some others) refuse to speak unless speechSynthesis was
  // first invoked from inside a user gesture. Call this from a tap/click once so
  // later network-triggered replies are allowed to play.
  unlock() {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch { /* noop */ }
  }

  // Speaks `text`. Callbacks: onStart, onBoundary (per word), onEnd.
  async speak(text, { onStart, onBoundary, onEnd } = {}) {
    await this.ready;
    speechSynthesis.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.voice?.lang || 'ar-SA';
      if (this.voice) u.voice = this.voice;
      u.rate = 0.9;   // a touch slower for learners
      u.pitch = 1.0;

      u.onstart = () => onStart?.();
      u.onboundary = () => onBoundary?.();
      u.onend = () => { onEnd?.(); resolve(); };
      u.onerror = () => { onEnd?.(); resolve(); };

      speechSynthesis.speak(u);
    });
  }

  stop() { speechSynthesis.cancel(); }
}
