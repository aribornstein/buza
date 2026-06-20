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

// The runtime allocates a float32 KV cache sized to `defaultCapacity` =
// min(8192, config.max_position_embeddings) tokens, across every non-shared
// layer. On a phone/tablet (iOS/iPadOS Safari ≈ 1GB GPU budget) the default
// 8192-token cache can be 0.3–1.3GB on its own and OOM-kills the tab on top of
// the ~1GB of weights. We cap it to fit the device by rewriting the model's
// config.json `max_position_embeddings` (the only value `defaultCapacity` reads)
// through Gemma4Mobile.load's public `fetch` hook.
const HARD_CAP = 8192; // runtime's own ceiling (`Us`)
const GB = 1024 * 1024 * 1024;
const mbStr = (n) => (typeof n === 'number' ? (n / 1048576).toFixed(0) + 'MB' : '?');

// float32 (4 bytes) × key+value (2) × kvOut × non-shared layers.
function kvBytesPerToken(cfg) {
  const kvHeads = cfg.num_key_value_heads ?? cfg.num_attention_heads ?? 1;
  const headDim = cfg.head_dim ?? 256;
  const layers = cfg.num_hidden_layers ?? 1;
  const shared = cfg.num_kv_shared_layers ?? 0;
  const nonShared = Math.max(1, layers - shared);
  return { perToken: 2 * 4 * kvHeads * headDim * nonShared, nonShared, kvOut: kvHeads * headDim };
}

// Pick a KV-cache capacity (in tokens) that fits the device's GPU budget. On a
// generous desktop GPU we keep the full default; on constrained mobile GPUs we
// trim so weights + cache + activations stay within the memory budget.
function chooseKvCapacity(cfg, limits, requested) {
  const defaultCap = Math.max(1, Math.min(HARD_CAP, cfg.max_position_embeddings ?? HARD_CAP));
  if (requested) return Math.max(256, Math.min(defaultCap, requested));

  const maxBuf = Number(limits?.maxBufferSize) || 0;
  if (maxBuf >= 4 * GB || maxBuf === 0) return defaultCap; // desktop / unknown: afford full

  const { perToken } = kvBytesPerToken(cfg);
  // Reserve a slice of the single-buffer budget for the KV cache.
  const kvBudget = maxBuf >= 2 * GB ? 384 * 1024 * 1024 : 160 * 1024 * 1024;
  let cap = Math.floor(kvBudget / perToken);
  cap = Math.max(1024, Math.min(defaultCap, cap)); // never below a usable 1024
  return Math.floor(cap / 256) * 256; // snap to a tidy multiple
}

// Wrap fetch so the model's config.json comes back with a capped
// max_position_embeddings (only ever lowered, never raised).
function makeConfigCappingFetch(baseFetch, limits, requested, emit) {
  const f = baseFetch || ((...a) => globalThis.fetch(...a));
  return async (input, init) => {
    const res = await f(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      const last = url.split('?')[0].split('#')[0].split('/').pop();
      if (last !== 'config.json' || !res.ok) return res;

      const cfg = await res.clone().json();
      const defaultCap = Math.max(1, Math.min(HARD_CAP, cfg.max_position_embeddings ?? HARD_CAP));
      const cap = chooseKvCapacity(cfg, limits, requested);
      const { perToken, nonShared, kvOut } = kvBytesPerToken(cfg);
      emit?.(`KV cache: ${nonShared}L × kvOut ${kvOut} f32 = ${(perToken / 1024).toFixed(0)}KB/token`);

      if (cap >= defaultCap) {
        emit?.(`KV cap: keeping default ${defaultCap} tokens (~${mbStr(defaultCap * perToken)})`);
        return res; // generous device — leave config untouched
      }
      Tutor._lastKvCapacity = cap;
      emit?.(`KV cap: ${cap} tokens (~${mbStr(cap * perToken)}) — was ${defaultCap} (~${mbStr(defaultCap * perToken)}) [maxBufferSize ${mbStr(Number(limits?.maxBufferSize))}]`);
      cfg.max_position_embeddings = cap;
      return new Response(JSON.stringify(cfg), {
        status: res.status,
        statusText: res.statusText,
        headers: { 'content-type': 'application/json' },
      });
    } catch (e) {
      console.warn('config cap failed; using original config', e);
      return res;
    }
  };
}

export class Tutor {
  constructor() {
    this.model = null;
    this.dialect = 'palestinian';
    this.history = []; // {role:'user'|'assistant', content}
    this.maxContextTokens = HARD_CAP;
  }

  async load(onProgress, opts = {}) {
    const { limits = null, emit = null, maxContextTokens = null } = opts;
    Tutor._lastKvCapacity = null;
    // Gemma4Mobile.load drives its own download/compile pipeline and reports
    // progress via {status, kind, fraction, message}. Translate that into the
    // {status:'progress', file, progress} shape main.js's onProgress expects.
    this.model = await Gemma4Mobile.load(null, {
      fetch: makeConfigCappingFetch(undefined, limits, maxContextTokens, emit),
      onProgress: (e) => {
        if (e.status === 'weights' && e.kind === 'bytes') {
          const pct = typeof e.fraction === 'number' ? e.fraction * 100 : 0;
          onProgress?.({ status: 'progress', file: 'gemma-4-E2B', progress: pct, loadedBytes: e.loaded, totalBytes: e.total });
        } else if (e.status === 'weights' && e.kind === 'tensors') {
          const pct = typeof e.fraction === 'number' ? e.fraction * 100 : 0;
          onProgress?.({ status: 'progress', file: 'gemma-4-E2B', progress: pct });
        } else if (e.status === 'ready') {
          onProgress?.({ status: 'done' });
        }
      },
    });
    // Remember the (possibly capped) context length so reply() can keep the
    // conversation history from overflowing the KV cache.
    this.maxContextTokens = Tutor._lastKvCapacity || HARD_CAP;
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
    this._trimHistory();

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

  // Drops the oldest turns so the prompt + reply stay within the (possibly
  // hardware-capped) KV cache. Rough estimate: ~3 chars per token; reserve
  // room for the system prompt and the new reply (maxNewTokens 256).
  _trimHistory() {
    const budget = Math.max(256, this.maxContextTokens - 256 - 256);
    const estTokens = () =>
      (SYSTEM_PROMPTS[this.dialect].length +
        this.history.reduce((n, m) => n + m.content.length, 0)) / 3;
    while (this.history.length > 1 && estTokens() > budget) {
      this.history.shift(); // oldest user
      if (this.history.length > 1 && this.history[0].role === 'assistant') {
        this.history.shift(); // its assistant reply
      }
    }
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
