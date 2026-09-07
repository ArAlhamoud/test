/**
 * Kokoro neural text-to-speech, off the main thread.
 *
 * Loads the Kokoro-82M ONNX model (Apache-2.0, from the Hugging Face hub) and
 * synthesises speech. Runs on WebGPU when the browser offers it, otherwise on
 * multi-threaded WASM. Audio is returned as raw Float32 samples so the page can
 * play it through the Web Audio API without a WAV round-trip.
 */

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts = null;
let loadPromise = null;
let device = null;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

async function build(preferGPU) {
  const useGPU = preferGPU && typeof navigator !== "undefined" && !!navigator.gpu;
  const opts = useGPU ? { device: "webgpu", dtype: "fp32" } : { device: "wasm", dtype: "q8" };
  const instance = await KokoroTTS.from_pretrained(MODEL_ID, {
    ...opts,
    progress_callback: (p) => {
      if (p?.status === "progress" && p.file && typeof p.progress === "number") {
        post({ type: "progress", file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
      }
    },
  });
  device = opts.device;
  return instance;
}

function load() {
  if (tts) return Promise.resolve(tts);
  if (!loadPromise) {
    loadPromise = (async () => {
      // Serve the ONNX runtime from our own origin instead of a third-party CDN.
      try {
        env.backends.onnx.wasm.wasmPaths = new URL("/ort/", self.location.origin).href;
        // Threaded WASM needs SharedArrayBuffer, which needs a cross-origin-isolated
        // page. Without that, asking for threads makes the runtime hang, so stay at 1.
        env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
          ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
          : 1;
      } catch { /* older runtimes */ }
      try {
        tts = await build(true);
      } catch (err) {
        // WebGPU can fail late (no adapter, driver refusal): fall back to WASM.
        post({ type: "notice", message: `WebGPU unavailable (${String(err?.message || err).slice(0, 120)}), using CPU` });
        tts = await build(false);
      }
      post({ type: "ready", device, voices: Object.entries(tts.voices).map(([id, v]) => ({ id, ...v })) });
      return tts;
    })().catch((err) => {
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === "load") {
      await load();
      post({ id, type: "loaded", device });
      return;
    }
    if (type === "generate") {
      const engine = await load();
      const audio = await engine.generate(payload.text, {
        voice: payload.voice,
        speed: typeof payload.speed === "number" ? payload.speed : 1,
      });
      const data = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
      post({ id, type: "audio", sampleRate: audio.sampling_rate, data }, [data.buffer]);
      return;
    }
  } catch (err) {
    post({ id, type: "error", error: String(err?.message || err) });
  }
};
