// llm.js — The tutor's "brain": Gemma-4 E2B (QAT mobile) running on WebGPU via
// the self-contained Gemma4Mobile runtime (custom WGSL kernels — no ONNX Runtime,
// so it doesn't need SharedArrayBuffer / cross-origin isolation). Streams tokens
// so the UI feels responsive.
//
// Mirrors the webml-community/gemma-4-webgpu-kernels demo:
//   https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels

import { Gemma4Mobile } from './gemma-4-e2b.js';

const SYSTEM_PROMPTS = {
  palestinian: `You are "Mu'allim" (معلّم), a warm, patient tutor of PALESTINIAN colloquial Arabic (Levantine, اللهجة الفلسطينية).
Goals:
- Help the learner practice everyday spoken Palestinian Arabic.
- Reply in authentic Palestinian dialect (e.g. say "كيفك؟", "شو؟", "بدي", "هلّأ", "منيح", "يلّا"), NOT Modern Standard Arabic, unless asked.
- Keep replies SHORT (1–3 sentences) so they are easy to say aloud and repeat.
- Gently correct the learner's mistakes and encourage them.

ALWAYS format every reply EXACTLY like this, with these three labelled lines and nothing else:
AR: <your reply in Palestinian Arabic script>
TR: <simple Latin transliteration>
EN: <English translation>`,

  msa: `You are "Mu'allim" (معلّم), a warm, patient tutor of Modern Standard Arabic (الفصحى).
Keep replies SHORT (1–3 sentences) in clear MSA, gently correct mistakes, and encourage the learner.

ALWAYS format every reply EXACTLY like this, with these three labelled lines and nothing else:
AR: <your reply in Arabic script>
TR: <simple Latin transliteration>
EN: <English translation>`,
};

export class Tutor {
  constructor() {
    this.model = null;
    this.dialect = 'palestinian';
    this.history = []; // {role:'user'|'assistant', content}
  }

  async load(onProgress) {
    // Gemma4Mobile.load drives its own download/compile pipeline and reports
    // progress via {status, kind, fraction, message}. Translate that into the
    // {status:'progress', file, progress} shape main.js's onProgress expects.
    this.model = await Gemma4Mobile.load(null, {
      onProgress: (e) => {
        if (e.status === 'weights' && e.kind === 'bytes') {
          const pct = typeof e.fraction === 'number' ? e.fraction * 100 : 0;
          onProgress?.({ status: 'progress', file: 'gemma-4-E2B', progress: pct });
        } else if (e.status === 'ready') {
          onProgress?.({ status: 'done' });
        }
      },
    });
    // Compile/warm the WebGPU kernels so the first real reply isn't slow.
    await this.model.warmup();
  }

  setDialect(d) {
    this.dialect = d;
    this.reset(); // reset context when the dialect changes
  }

  reset() {
    this.history = [];
    this.model?.reset();
  }

  // Generates a reply. `onToken` receives the growing text for live streaming.
  async reply(userText, onToken) {
    this.history.push({ role: 'user', content: userText });

    // Gemma's chat template has no `system` role, so fold the system prompt into
    // the first user turn. Keeping it on the first (stable) message lets the
    // runtime reuse its KV cache across turns via prompt-prefix matching.
    const messages = this.history.map((m, i) =>
      i === 0 && m.role === 'user'
        ? { role: 'user', content: `${SYSTEM_PROMPTS[this.dialect]}\n\n${m.content}` }
        : m
    );

    let full = '';
    for await (const { text } of this.model.generate(messages, { maxNewTokens: 256 })) {
      full = text;
      onToken?.(full);
    }
    full = full.trim();

    this.history.push({ role: 'assistant', content: full });
    return full;
  }
}

// Parses the AR / TR / EN structured reply. Falls back gracefully if the
// model didn't follow the format.
export function parseReply(text) {
  const grab = (label) => {
    const m = text.match(new RegExp(`${label}\\s*:\\s*(.+?)(?=\\n[A-Z]{2}\\s*:|$)`, 's'));
    return m ? m[1].trim() : '';
  };
  const ar = grab('AR');
  const tr = grab('TR');
  const en = grab('EN');
  if (!ar && !tr && !en) return { ar: text.trim(), tr: '', en: '' };
  return { ar, tr, en };
}
