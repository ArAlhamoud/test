/**
 * Tiny synthesized sound effects for Immersive Mode (no audio assets needed).
 * Everything is generated with the Web Audio API on first use.
 */
let ctx = null;

function getContext() {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** Short "whoosh" used when the camera moves to the next panel. */
export function playWhoosh(volume = 0.16) {
  try {
    const ac = getContext();
    if (!ac) return;
    const t = ac.currentTime;
    const dur = 0.38;
    const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.55);
    filter.frequency.exponentialRampToValueAtTime(420, t + dur);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.07);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start(t);
    src.stop(t + dur);
  } catch (err) {
    console.warn("playWhoosh failed", err);
  }
}

/** Soft low "thump" used on page turns. */
export function playPageTurn(volume = 0.12) {
  try {
    const ac = getContext();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.25);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  } catch (err) {
    console.warn("playPageTurn failed", err);
  }
}
