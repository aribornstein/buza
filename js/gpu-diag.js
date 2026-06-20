// gpu-diag.js — WebGPU crash diagnostics for the gateway device (esp. iOS Safari).
//
// The Gemma-4 bundle creates its own WebGPU device, registers only a
// `console.error` for uncaptured errors, and has NO `device.lost` handler. So
// when iOS runs out of its (small) GPU / unified-memory budget the device is
// lost — or the whole tab is OOM-killed and reloads — with nothing on screen.
//
// This module makes the real cause visible:
//   • patches GPUAdapter.requestDevice so every device the runtime creates gets
//     `device.lost` + `uncapturederror` handlers,
//   • catches window 'error' / 'unhandledrejection',
//   • records a timestamped trail to localStorage that SURVIVES a tab reload, so
//     after an OOM crash we can read exactly how far loading got and why it died,
//   • renders a small on-device panel (no DevTools needed on the phone).

const KEY = 'buza:gpudiag';

function readRec() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
function writeRec(rec) {
  try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch { /* private mode / quota */ }
}

function mountPanel() {
  let pre = document.getElementById('gpu-diag-panel');
  if (pre) return pre;
  const wrap = document.createElement('div');
  wrap.id = 'gpu-diag-wrap';
  wrap.style.cssText =
    'position:fixed;left:6px;right:6px;bottom:6px;z-index:99999;font:11px/1.35 ui-monospace,Menlo,monospace;';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;margin-bottom:4px;';
  const mk = (label) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'font:11px ui-monospace,monospace;padding:3px 8px;border-radius:6px;border:1px solid #475569;background:#0b1220;color:#e5e7eb;'; return b; };
  const copyBtn = mk('copy'); const clearBtn = mk('clear'); const hideBtn = mk('hide');
  bar.append(copyBtn, clearBtn, hideBtn);
  pre = document.createElement('pre');
  pre.id = 'gpu-diag-panel';
  pre.style.cssText =
    'max-height:38vh;overflow:auto;margin:0;padding:8px;border-radius:8px;' +
    'background:rgba(2,6,23,.92);color:#cbd5e1;border:1px solid #334155;white-space:pre-wrap;word-break:break-word;';
  wrap.append(bar, pre);
  copyBtn.addEventListener('click', () => { navigator.clipboard?.writeText(pre.textContent).catch(() => {}); });
  clearBtn.addEventListener('click', () => { writeRec(null); pre.textContent = ''; });
  hideBtn.addEventListener('click', () => wrap.remove());
  (document.body || document.documentElement).appendChild(wrap);
  return pre;
}

const mb = (n) => (typeof n === 'number' ? (n / 1048576).toFixed(0) + 'MB' : '?');

export function installGpuDiagnostics({ showPanel = true } = {}) {
  const panel = showPanel ? mountPanel() : null;
  const render = () => {
    if (!panel) return;
    const rec = readRec();
    panel.textContent = (rec?.lines || []).join('\n');
    panel.scrollTop = panel.scrollHeight;
  };

  const emit = (msg) => {
    const t = new Date().toISOString().slice(11, 23);
    const line = `${t}  ${msg}`;
    const rec = readRec() || { started: Date.now(), lines: [] };
    rec.lines = (rec.lines || []).concat(line).slice(-120);
    rec.updated = Date.now();
    writeRec(rec);
    render();
    console.log('[gpudiag]', line);
  };

  const stage = (s) => {
    const rec = readRec() || { lines: [] };
    rec.lastStage = s; writeRec(rec);
    emit('▶ STAGE: ' + s);
  };

  // Replay the previous session FIRST — this is the whole point: if iOS OOM-killed
  // the tab, the trail below ends exactly where it died (and survives the reload).
  const prev = readRec();
  if (prev?.lines?.length) {
    emit('──── previous session (last stage: ' + (prev.lastStage || '?') + ') ────');
  }
  // Reset for this run while keeping the replayed lines in view.
  const carried = (readRec()?.lines || []).slice(-40);
  writeRec({ started: Date.now(), lines: carried, lastStage: 'init' });
  render();

  // Global JS failures (the bundle's async work can reject far from our try/catch).
  if (!window.__buzaDiagGlobals) {
    window.addEventListener('error', (e) => emit('window.error: ' + (e.message || e.error?.message || e)));
    window.addEventListener('unhandledrejection', (e) => emit('unhandledrejection: ' + (e.reason?.message || e.reason || e)));
    window.__buzaDiagGlobals = true;
  }

  // Patch every device the runtime makes with lost/error handlers.
  if (window.GPUAdapter && !GPUAdapter.prototype.__buzaPatched) {
    const orig = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (desc) {
      try { emit('requestDevice requiredLimits=' + JSON.stringify(desc?.requiredLimits || {})); } catch { /* noop */ }
      const device = await orig.call(this, desc);
      device.lost?.then((info) => emit('❌ DEVICE LOST [' + info.reason + ']: ' + (info.message || '(no message)')));
      device.addEventListener?.('uncapturederror', (ev) => emit('uncaptured GPU error: ' + (ev.error?.message || ev.error)));
      return device;
    };
    GPUAdapter.prototype.__buzaPatched = true;
  }

  return { emit, stage };
}

// If a prior session crashed (last stage wasn't 'ready'), show its trail right
// away on the next page load — without waiting for the user to retry. This is the
// key to debugging an iOS OOM tab-kill, which reloads the page and wipes console.
export function replayPrevious() {
  const rec = readRec();
  if (rec?.lines?.length && rec.lastStage && rec.lastStage !== 'ready') {
    const panel = mountPanel();
    panel.textContent = rec.lines.join('\n') +
      `\n──── (previous session ended at stage: ${rec.lastStage}) ────`;
    panel.scrollTop = panel.scrollHeight;
    return true;
  }
  return false;
}

// One-shot probe of the device ceiling. Reveals whether iOS simply can't fit the
// model: compare the weights total (logged during download) against maxBufferSize.
export async function probeWebGPU(emit) {
  const gpu = navigator.gpu;
  if (!gpu) { emit('WebGPU: NOT AVAILABLE in this browser context'); return null; }
  let adapter;
  try { adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); }
  catch (e) { emit('requestAdapter threw: ' + (e?.message || e)); return null; }
  if (!adapter) { emit('WebGPU: no adapter returned'); return null; }

  let info = adapter.info;
  if (!info && adapter.requestAdapterInfo) { try { info = await adapter.requestAdapterInfo(); } catch { /* noop */ } }
  info = info || {};
  const L = adapter.limits;
  const f16 = adapter.features.has('shader-f16');
  emit(`adapter: ${info.vendor || '?'} / ${info.architecture || '?'} ${info.description ? '/ ' + info.description : ''}`);
  emit(`features: shader-f16=${f16} subgroups=${adapter.features.has('subgroups')}`);
  emit(`limits: maxBufferSize=${mb(L.maxBufferSize)} maxStorageBinding=${mb(L.maxStorageBufferBindingSize)} ` +
       `storageBuffers/stage=${L.maxStorageBuffersPerShaderStage} wgStorage=${(L.maxComputeWorkgroupStorageSize / 1024).toFixed(0)}KB`);
  return { info, limits: L, f16 };
}
