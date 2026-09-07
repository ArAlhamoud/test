/**
 * Main-thread client for the Kokoro text-to-speech worker, plus playback.
 *
 * The worker is created lazily the first time a natural voice is requested, so
 * readers who stay on the browser's built-in voices never download the model.
 * Generated clips are cached in memory and can be produced ahead of playback.
 */

const CACHE_LIMIT = 80;

let worker = null;
let nextId = 1;
const pending = new Map();
const cache = new Map();
const listeners = new Set();

let state = {
  status: "idle", // idle | loading | ready | error
  device: null,   // "webgpu" | "wasm"
  progress: 0,    // 0-100 while downloading
  error: null,
  voices: [],
};

function setState(patch) {
  state = { ...state, ...patch };
  listeners.forEach((cb) => {
    try {
      cb(state);
    } catch { /* listener errors must not break playback */ }
  });
}

export function getVoiceState() {
  return state;
}

export function subscribeVoiceState(cb) {
  listeners.add(cb);
  cb(state);
  return () => listeners.delete(cb);
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../../workers/kokoro.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === "progress") {
      // Percentages arrive per file; the model file dominates the download.
      if (typeof msg.progress === "number") setState({ status: "loading", progress: Math.min(99, Math.round(msg.progress)) });
      return;
    }
    if (msg.type === "ready") {
      setState({ status: "ready", device: msg.device, progress: 100, error: null, voices: msg.voices || [] });
      return;
    }
    if (msg.type === "notice") {
      console.info("[neural voice]", msg.message);
      return;
    }
    const entry = msg.id != null ? pending.get(msg.id) : null;
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.type === "error") entry.reject(new Error(msg.error));
    else if (msg.type === "audio") entry.resolve({ data: msg.data, sampleRate: msg.sampleRate });
    else entry.resolve(msg);
  };
  worker.onerror = (err) => {
    const message = err?.message || "voice engine failed to start";
    setState({ status: "error", error: message });
    pending.forEach((entry) => entry.reject(new Error(message)));
    pending.clear();
  };
  return worker;
}

function send(type, payload, transfer) {
  const id = nextId++;
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload }, transfer || []);
  });
}

/** Start downloading / initialising the model. Safe to call repeatedly. */
export function loadNeuralVoice() {
  if (state.status === "ready") return Promise.resolve(state);
  if (state.status !== "loading") setState({ status: "loading", progress: 0, error: null });
  return send("load").then(
    (res) => {
      setState({ status: "ready", device: res.device || state.device, progress: 100 });
      return state;
    },
    (err) => {
      setState({ status: "error", error: String(err?.message || err) });
      throw err;
    },
  );
}

export function isNeuralReady() {
  return state.status === "ready";
}

function cacheKey(text, voice, speed) {
  return `${voice}|${speed}|${text}`;
}

const GENERATE_TIMEOUT_MS = 40000;

/**
 * Synthesise a line (cached). Returns { data: Float32Array, sampleRate }.
 * Rejects if the engine takes too long, so the caller can fall back to the
 * browser voice instead of leaving the reader stuck on one panel.
 */
export async function synthesize(text, { voice = "af_heart", speed = 1 } = {}) {
  const key = cacheKey(text, voice, speed);
  const hit = cache.get(key);
  if (hit) return hit;
  let timer;
  const clip = await Promise.race([
    send("generate", { text, voice, speed }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("voice generation timed out")), GENERATE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  cache.set(key, clip);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return clip;
}

/** Has this exact line already been synthesised? */
export function isCached(text, { voice = "af_heart", speed = 1 } = {}) {
  return cache.has(cacheKey(text, voice, speed));
}

/** Generate in the background without waiting for or throwing on the result. */
export function prefetch(text, opts) {
  if (!text || state.status !== "ready") return;
  const key = cacheKey(text, opts?.voice || "af_heart", opts?.speed ?? 1);
  if (cache.has(key)) return;
  synthesize(text, opts).catch(() => {});
}

/* ------------------------------------------------------------- playback */

let audioCtx = null;
let currentSource = null;

function getContext() {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

export function unlockAudio() {
  getContext();
}

/**
 * Play a clip; resolves when it finishes, is stopped, or cannot play.
 * Never hangs: a suspended audio context (no user gesture yet, which is the
 * normal state on iOS) resolves quickly so the reader keeps moving.
 */
export function playClip({ data, sampleRate }) {
  return new Promise((resolve) => {
    const ctx = getContext();
    if (!ctx || !data?.length) return resolve("unsupported");
    let done = false;
    let guard;
    let gestureCheck;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      clearTimeout(gestureCheck);
      resolve(why);
    };
    try {
      const buffer = ctx.createBuffer(1, data.length, sampleRate);
      buffer.getChannelData(0).set(data);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (currentSource === source) currentSource = null;
        finish("end");
      };
      stopPlayback();
      currentSource = source;
      source.start();
      // Safety net in case "ended" never fires (throttled tab, odd audio stack).
      guard = setTimeout(() => finish(ctx.state === "running" ? "end" : "suspended"), (data.length / sampleRate) * 1000 + 2500);
      if (ctx.state !== "running") {
        ctx.resume?.().catch(() => {});
        gestureCheck = setTimeout(() => {
          if (ctx.state !== "running") {
            stopPlayback();
            finish("suspended");
          }
        }, 1200);
      }
    } catch (err) {
      finish(`error: ${err?.message || err}`);
    }
  });
}

export function stopPlayback() {
  if (!currentSource) return;
  try {
    currentSource.onended = null;
    currentSource.stop();
  } catch { /* already stopped */ }
  currentSource = null;
}
