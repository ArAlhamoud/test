/**
 * Copy the ONNX runtime files that transformers.js needs at runtime into
 * public/ort, so the browser loads them from this app instead of a third-party
 * CDN. Runs automatically before `npm run dev` and `npm run build`.
 */
import { mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";

const SRC = path.join(process.cwd(), "node_modules", "@huggingface", "transformers", "dist");
const DEST = path.join(process.cwd(), "public", "ort");
const FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];

try {
  await access(SRC);
} catch {
  console.warn("[ort] @huggingface/transformers not installed; skipping asset copy");
  process.exit(0);
}

await mkdir(DEST, { recursive: true });
for (const file of FILES) {
  try {
    await copyFile(path.join(SRC, file), path.join(DEST, file));
  } catch (err) {
    console.warn(`[ort] could not copy ${file}:`, err.message);
  }
}
console.log(`[ort] runtime assets ready in public/ort`);
