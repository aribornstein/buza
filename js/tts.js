// tts.js — Speaks the tutor's Arabic reply using the browser's Web Speech API,
// and pulses the avatar's mouth on each word boundary for lip-sync.

const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) ||
  (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent);

export class Speaker {
  constructor() {
    this.voice = null;
    this._unlocked = false;
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

  // On iOS, using the mic (e.g. pairing by sound) switches the audio session to
  // a record category that mutes speechSynthesis for the rest of the page's
  // life. iOS Safari 16.4+ lets us reclaim the speaker for output by setting the
  // audio session type to 'playback'. Only call this right before speaking —
  // 'playback' is output-only and would block mic capture (pairing/recording).
  // Safe no-op where the API is absent. Returns true if it *changed* the
  // category (the iOS audio route then needs a moment to settle before speech).
  _claimAudioOutput() {
    try {
      const s = navigator.audioSession;
      if (s && s.type !== 'playback') { s.type = 'playback'; return true; }
    } catch { /* noop */ }
    return false;
  }

  // Public: proactively switch the audio session to output mode. Call this from
  // lifecycle events (connection opened, recording stopped) so the route is
  // already 'playback' and settled by the time a reply needs to be spoken —
  // iOS drops the first utterance issued during the category switch itself.
  claimOutput() {
    return this._claimAudioOutput();
  }

  // iOS Safari refuses to speak unless speechSynthesis was first triggered from
  // inside a user gesture, and that permission only lasts a short window after
  // the gesture. The client re-calls this on every pointerdown so the window
  // stays fresh; each call resumes the synth and primes it with a near-silent
  // real utterance (volume:0 utterances are skipped by iOS and don't count).
  unlock() {
    try {
      speechSynthesis.resume();
      this._unlocked = true;
      // Don't interrupt a reply that's currently playing.
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance('\u200b'); // zero-width space
      u.volume = 0.01;
      u.rate = 10; // finish almost instantly
      speechSynthesis.speak(u);
    } catch { /* noop */ }
  }

  // Speaks `text`. Callbacks: onStart, onBoundary (per word), onEnd, onError.
  async speak(text, { onStart, onBoundary, onEnd, onError } = {}) {
    // Don't let a stuck voices-promise block speech indefinitely.
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 1500))]);
    this._ensureVoice();

    // The pattern proven to work on iOS (out-of-gesture, after a recent unlock):
    // resume() → cancel() → speak(). Skipping cancel() leaves the reply stuck
    // behind an idle/parked synth and it never starts.
    const switched = this._claimAudioOutput();
    speechSynthesis.resume();
    speechSynthesis.cancel();

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
      u.onerror = (e) => { onError?.(e); finish(); };

      const fire = () => {
        speechSynthesis.speak(u);
        // iOS sometimes parks the synth in a paused state right after speak();
        // a follow-up resume() nudges it into actually starting.
        if (IS_IOS) speechSynthesis.resume();
      };

      // If we just flipped the audio category, iOS drops an utterance fired
      // mid-switch. Give the route a moment to settle first (lifecycle hooks
      // usually switch ahead of time, so this branch rarely runs).
      if (switched && IS_IOS) setTimeout(fire, 300);
      else fire();
    });
  }

  stop() {
    speechSynthesis.cancel();
  }
}
