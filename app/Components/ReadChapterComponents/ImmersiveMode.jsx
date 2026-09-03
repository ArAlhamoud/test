"use client";

/**
 * Immersive Mode v2: cinematic, panel-by-panel reading.
 *  - camera glides / punches / hard-cuts between panels (impact cuts on SFX panels)
 *  - spotlight, letterbox, film grain, vignette, speed-line bursts, flashes
 *  - narration: OCR (server) -> per-panel text -> Web Speech, with subtitles
 *  - pages load straight from MangaDex (CORS) with an optimizer fallback
 *  - built-in diagnostics so a silent narration explains itself
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Settings,
  Volume2, VolumeX, Captions, CaptionsOff, Maximize2, Minimize2, Focus, Loader2,
  HelpCircle, AlertTriangle, Film,
} from "lucide-react";
import { detectPanels, ocrBoxSpace, assignTextToPanels } from "../../util/ReadChapterUtils/detectPanels";
import { playWhoosh, playPageTurn } from "../../util/ReadChapterUtils/immersiveAudio";

const SETTINGS_KEY = "immersiveModeSettings";
export const IMMERSIVE_RESUME_KEY = "immersiveModeResume";

const DEFAULT_SETTINGS = {
  narration: true,
  subtitles: true,
  subtitleStyle: "anime",   // "anime" | "box"
  spotlight: true,
  letterbox: true,
  grain: true,
  impactCuts: true,
  sfx: true,
  rate: 1,
  voiceName: "",
  dwell: 4,                 // seconds on a panel with nothing to read
  framing: "normal",        // "tight" | "normal" | "wide"
  direction: "auto",        // "auto" | "rtl" | "ltr"
  showPanels: false,        // debug: outline every detected panel
};

const GLIDE = "1.1s cubic-bezier(0.22, 0.9, 0.25, 1)";
const PUNCH = "0.55s cubic-bezier(0.34, 1.4, 0.64, 1)";

/* ------------------------------------------------------------------ helpers */

function loadSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function proxiedSrc(url) {
  return `/_next/image?url=${encodeURIComponent(url)}&w=1920&q=75`;
}

function pageSrc(url, mode) {
  return mode === "proxy" ? proxiedSrc(url) : url;
}

/** True when the browser lets us read this image's pixels (CORS ok). */
function canReadPixels(img) {
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function loadReadableImage(url) {
  // Try the direct (CORS) URL first, then fall back to the same-origin optimizer.
  return new Promise((resolve, reject) => {
    const tryMode = (mode) => {
      const img = new Image();
      if (mode === "direct") img.crossOrigin = "anonymous";
      img.onload = () => {
        if (mode === "direct" && !canReadPixels(img)) return tryMode("proxy");
        resolve({ img, mode });
      };
      img.onerror = () => (mode === "direct" ? tryMode("proxy") : reject(new Error("image failed to load")));
      img.src = pageSrc(url, mode);
    };
    tryMode("direct");
  });
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/[|_~^]+/g, "").trim();
}

/** ALL-CAPS manga lettering -> sentence case so voices don't spell it out. */
function humanize(text) {
  let t = cleanText(text);
  const letters = t.replace(/[^A-Za-z]/g, "");
  const upper = letters.replace(/[^A-Z]/g, "").length;
  if (letters.length >= 3 && upper / letters.length > 0.8) {
    t = t.toLowerCase()
      .replace(/(^\s*[a-z]|[.!?]\s+[a-z])/g, (m) => m.toUpperCase())
      .replace(/\bi\b/g, "I")
      .replace(/\bi'(m|ll|ve|d)\b/g, (m, s) => `I'${s}`);
  }
  return t;
}

function splitForSpeech(text, max = 260) {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Speak one chunk. Resolves with {why, error}. Never hangs: if the engine never
 * even starts within 3s we give up on it, and long chunks have a generous guard.
 */
let speechProven = false; // set once any utterance actually started

function speakChunk(text, { voice, lang, rate }) {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis || !text) return resolve({ why: "unsupported" });
    const synth = window.speechSynthesis;
    let done = false;
    let started = false;
    let startGuard;
    let endGuard;
    const finish = (why, error) => {
      if (done) return;
      done = true;
      clearTimeout(startGuard);
      clearTimeout(endGuard);
      resolve({ why, error });
    };
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || lang || "en-US";
    u.rate = rate;
    u.pitch = 1;
    u.onstart = () => {
      started = true;
      speechProven = true;
      clearTimeout(startGuard);
      const words = text.split(/\s+/).length;
      endGuard = setTimeout(() => finish("timeout"), (words * 600) / rate + 3000);
    };
    u.onend = () => finish(started ? "end" : "end-without-start");
    u.onerror = (e) => finish("error", e?.error || "unknown");
    // Cloud-backed voices (Edge "Natural") may need several seconds before audio starts.
    startGuard = setTimeout(() => finish("nostart"), speechProven ? 6000 : 12000);
    try {
      const go = () => synth.speak(u);
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(go, 80);
      } else {
        go();
      }
      // Chrome pauses the queue in odd states; poke it.
      if (synth.paused) synth.resume();
    } catch (err) {
      finish("error", String(err?.message || err));
    }
  });
}

function makeNoiseDataUrl() {
  try {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 200;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(200, 200);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = 90 + Math.random() * 110;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
}

function classifyPanel(rect, texts) {
  if (!rect) return "glide";
  const sfx = texts.some((p) => p.h > rect.h * 0.16 || (/^[^a-z]{2,14}$/.test(p.raw) && p.h > rect.h * 0.09 && /[A-Z]/.test(p.raw)));
  if (sfx) return "impact";
  if (texts.some((p) => /!|\?!/.test(p.raw))) return "punch";
  return "glide";
}

/* ---------------------------------------------------------------- component */

export default function ImmersiveMode({
  pages = [],
  startIndex = 0,
  chapterInfo,
  mangaInfo,
  onExit,
  goToNextChapter,
  hasNextChapter,
}) {
  const [settings, setSettings] = useState(loadSettings);
  const [pageIdx, setPageIdx] = useState(() => Math.min(Math.max(0, startIndex), Math.max(0, pages.length - 1)));
  const [panelIdx, setPanelIdx] = useState(0);
  const [panelsByPage, setPanelsByPage] = useState({});
  const [ocrByPage, setOcrByPage] = useState({});     // url -> paragraphs[] | "pending" | "failed"
  const [ocrErrors, setOcrErrors] = useState({});     // url -> reason
  const [srcModes, setSrcModes] = useState({});       // url -> "direct" | "proxy"
  const [imgReady, setImgReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [subtitle, setSubtitle] = useState("");
  const [showUI, setShowUI] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [voices, setVoices] = useState([]);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [titleCard, setTitleCard] = useState(true);
  const [chapterEnd, setChapterEnd] = useState(false);
  const [countdown, setCountdown] = useState(8);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [fx, setFx] = useState({ type: "glide", key: 0 });
  const [speechIssue, setSpeechIssue] = useState("");   // "" | "not-allowed" | "silent" | other error
  const [spokenCount, setSpokenCount] = useState(0);
  const [noise] = useState(() => (typeof window !== "undefined" ? makeNoiseDataUrl() : ""));

  const stageRef = useRef(null);
  const shakeRef = useRef(null);
  const driftRef = useRef(null);
  const imgRef = useRef(null);
  const runIdRef = useRef(0);
  const uiTimerRef = useRef(null);
  const pendingLastPanelRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const currentUrl = pages[pageIdx];
  const srcMode = srcModes[currentUrl] || "direct";
  const language = chapterInfo?.translatedLanguage || "en";

  const direction = useMemo(() => {
    if (settings.direction !== "auto") return settings.direction;
    const original = mangaInfo?.originalLanguage || "";
    const tags = mangaInfo?.flatTags || [];
    if (tags.includes("Long Strip") || tags.includes("Web Comic")) return "ltr";
    if (original === "ko" || original.startsWith("zh")) return "ltr";
    return "rtl";
  }, [settings.direction, mangaInfo]);

  const panels = panelsByPage[currentUrl] || null;
  const ocr = ocrByPage[currentUrl];
  const currentPanel = panels?.[panelIdx] || null;

  const panelTexts = useMemo(() => {
    if (!panels || !Array.isArray(ocr)) return null;
    return assignTextToPanels(panels, ocr, direction);
  }, [panels, ocr, direction]);

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  /* ---------- mount: viewport, fullscreen, resume flag ---------- */
  useEffect(() => {
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    try {
      window.sessionStorage.removeItem(IMMERSIVE_RESUME_KEY);
    } catch { /* ignore */ }
    try {
      stageRef.current?.requestFullscreen?.().catch?.(() => {});
    } catch { /* ignore */ }
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
      try {
        window.speechSynthesis?.cancel();
      } catch { /* ignore */ }
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else stageRef.current?.requestFullscreen?.();
    } catch { /* ignore */ }
  }, []);

  /* ---------- voices ---------- */
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => {
      const all = window.speechSynthesis.getVoices() || [];
      const prefix = language.slice(0, 2).toLowerCase();
      const matching = all.filter((v) => v.lang?.toLowerCase().startsWith(prefix));
      setVoices(matching.length ? matching : all);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    const retry = setTimeout(load, 1200); // some browsers populate late
    return () => {
      clearTimeout(retry);
      if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = null;
    };
  }, [language]);

  const selectedVoice = useMemo(() => {
    if (!voices.length) return null;
    return (
      voices.find((v) => v.name === settings.voiceName) ||
      voices.find((v) => /online.*natural|natural/i.test(v.name)) ||
      voices.find((v) => /neural|premium|enhanced|google/i.test(v.name)) ||
      voices[0]
    );
  }, [voices, settings.voiceName]);

  /* ---------- title card ---------- */
  useEffect(() => {
    const t = setTimeout(() => setTitleCard(false), 2800);
    return () => clearTimeout(t);
  }, []);

  /* ---------- auto-hide UI ---------- */
  const pokeUI = useCallback(() => {
    setShowUI(true);
    clearTimeout(uiTimerRef.current);
    uiTimerRef.current = setTimeout(() => {
      if (!showSettings && !showHelp) setShowUI(false);
    }, 3200);
  }, [showSettings, showHelp]);

  useEffect(() => {
    pokeUI();
    return () => clearTimeout(uiTimerRef.current);
  }, [pokeUI]);

  /* ---------- page change ---------- */
  useEffect(() => {
    setImgReady(false);
    setSubtitle("");
    runIdRef.current += 1;
    try {
      window.speechSynthesis?.cancel();
    } catch { /* ignore */ }
    if (!pendingLastPanelRef.current) setPanelIdx(0);
  }, [pageIdx]);

  // Preload the next two page images.
  useEffect(() => {
    [pages[pageIdx + 1], pages[pageIdx + 2]].filter(Boolean).forEach((url) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = pageSrc(url, srcModes[url] || "direct");
    });
  }, [pages, pageIdx, srcModes]);

  /* ---------- OCR ---------- */
  const runOCR = useCallback(async (url, imgEl) => {
    if (!url || !imgEl?.naturalWidth) return;
    setOcrByPage((prev) => (Array.isArray(prev[url]) ? prev : { ...prev, [url]: "pending" }));
    try {
      const nw = imgEl.naturalWidth;
      const nh = imgEl.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = nw;
      canvas.height = nh;
      canvas.getContext("2d").drawImage(imgEl, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("could not capture the page image");
      const form = new FormData();
      form.append("file", new File([blob], "page.jpg", { type: "image/jpeg" }));
      form.append("language", language);
      const res = await fetch("/api/readTextAndReplace", { method: "POST", body: form });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          detail = j?.error || j?.message || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      const json = await res.json();
      const processed = json?.metadata?.imageProcessing?.dimensions || { width: nw, height: nh };
      const space = ocrBoxSpace(processed.width, processed.height);
      const sx = nw / space.w;
      const sy = nh / space.h;
      const source = Array.isArray(json.paragraphs) && json.paragraphs.length ? json.paragraphs : json.data || [];
      const paragraphs = source
        .filter((p) => p && Array.isArray(p.bbox) && p.bbox.length >= 4)
        .map((p) => {
          const xs = p.bbox.map((b) => b[0]);
          const ys = p.bbox.map((b) => b[1]);
          const raw = cleanText(p.text);
          return {
            raw,
            text: humanize(raw),
            x: Math.min(...xs) * sx,
            y: Math.min(...ys) * sy,
            w: (Math.max(...xs) - Math.min(...xs)) * sx,
            h: (Math.max(...ys) - Math.min(...ys)) * sy,
          };
        })
        .filter((p) => p.text.length > 1 && /[\p{L}\p{N}]/u.test(p.text));
      setOcrByPage((prev) => ({ ...prev, [url]: paragraphs }));
    } catch (err) {
      console.warn("Immersive OCR failed:", err);
      setOcrErrors((prev) => ({ ...prev, [url]: String(err?.message || err) }));
      setOcrByPage((prev) => ({ ...prev, [url]: "failed" }));
    }
  }, [language]);

  const handleImageLoad = useCallback(() => {
    const imgEl = imgRef.current;
    const url = currentUrl;
    if (!imgEl || !url) return;
    // Direct image but pixels unreadable (no CORS from this node)? Reload through the optimizer.
    if (srcMode === "direct" && !canReadPixels(imgEl)) {
      setSrcModes((prev) => ({ ...prev, [url]: "proxy" }));
      return;
    }
    if (!panelsByPage[url]) {
      setStatusText("Detecting panels…");
      setTimeout(() => {
        let rects = [];
        try {
          rects = detectPanels(imgEl, { direction });
        } catch (err) {
          console.warn("Panel detection failed", err);
        }
        if (!rects.length) rects = [{ x: 0, y: 0, w: imgEl.naturalWidth, h: imgEl.naturalHeight }];
        setPanelsByPage((prev) => ({ ...prev, [url]: rects }));
        if (pendingLastPanelRef.current) {
          pendingLastPanelRef.current = false;
          setPanelIdx(rects.length - 1);
        }
        setStatusText("");
        setImgReady(true);
      }, 30);
    } else {
      if (pendingLastPanelRef.current) {
        pendingLastPanelRef.current = false;
        setPanelIdx(panelsByPage[url].length - 1);
      }
      setImgReady(true);
    }
    if (settingsRef.current.narration && !ocrByPage[url]) runOCR(url, imgEl);
  }, [currentUrl, srcMode, panelsByPage, ocrByPage, direction, runOCR]);

  const handleImageError = useCallback(() => {
    if (srcMode === "direct") setSrcModes((prev) => ({ ...prev, [currentUrl]: "proxy" }));
    else setStatusText("Could not load this page");
  }, [srcMode, currentUrl]);

  // Narration switched on later -> OCR the current page on demand.
  useEffect(() => {
    if (settings.narration && imgReady && currentUrl && !ocrByPage[currentUrl] && imgRef.current) {
      runOCR(currentUrl, imgRef.current);
    }
  }, [settings.narration, imgReady, currentUrl, ocrByPage, runOCR]);

  // Prefetch OCR two pages ahead so narration never waits after the first page.
  useEffect(() => {
    if (!settings.narration || !Array.isArray(ocr)) return;
    [pages[pageIdx + 1], pages[pageIdx + 2]].filter(Boolean).forEach((nextUrl) => {
      if (ocrByPage[nextUrl]) return;
      setOcrByPage((prev) => (prev[nextUrl] ? prev : { ...prev, [nextUrl]: "pending" }));
      loadReadableImage(nextUrl)
        .then(({ img, mode }) => {
          if (mode === "proxy") setSrcModes((prev) => ({ ...prev, [nextUrl]: "proxy" }));
          return runOCR(nextUrl, img);
        })
        .catch((err) => {
          setOcrErrors((prev) => ({ ...prev, [nextUrl]: String(err?.message || err) }));
          setOcrByPage((prev) => ({ ...prev, [nextUrl]: "failed" }));
        });
    });
  }, [settings.narration, ocr, pages, pageIdx, ocrByPage, runOCR]);

  const waitingForOCR = settings.narration && ocr === "pending";

  // Never wait forever for the OCR service.
  useEffect(() => {
    if (!waitingForOCR || !currentUrl) return;
    const url = currentUrl;
    const t = setTimeout(() => {
      setOcrErrors((prev) => ({ ...prev, [url]: "timed out after 45s" }));
      setOcrByPage((prev) => (prev[url] === "pending" ? { ...prev, [url]: "failed" } : prev));
    }, 45000);
    return () => clearTimeout(t);
  }, [waitingForOCR, currentUrl]);

  // Re-detect panels after the reading direction changes (cache was cleared).
  useEffect(() => {
    const imgEl = imgRef.current;
    if (!imgReady && currentUrl && !panelsByPage[currentUrl] && imgEl?.complete && imgEl.naturalWidth) handleImageLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelsByPage]);

  /* ---------- navigation ---------- */
  const goNextPanel = useCallback(() => {
    if (!panels) return;
    if (panelIdx + 1 < panels.length) {
      setPanelIdx(panelIdx + 1);
    } else if (pageIdx + 1 < pages.length) {
      if (settingsRef.current.sfx) playPageTurn();
      setPageIdx(pageIdx + 1);
    } else {
      setChapterEnd(true);
      setPlaying(false);
    }
  }, [panels, panelIdx, pageIdx, pages.length]);

  const goPrevPanel = useCallback(() => {
    if (panelIdx > 0) setPanelIdx(panelIdx - 1);
    else if (pageIdx > 0) {
      pendingLastPanelRef.current = true;
      setPageIdx(pageIdx - 1);
    }
  }, [panelIdx, pageIdx]);

  const goNextPage = useCallback(() => {
    if (pageIdx + 1 < pages.length) setPageIdx(pageIdx + 1);
    else {
      setChapterEnd(true);
      setPlaying(false);
    }
  }, [pageIdx, pages.length]);

  const goPrevPage = useCallback(() => {
    if (pageIdx > 0) setPageIdx(pageIdx - 1);
  }, [pageIdx]);

  const exit = useCallback(() => {
    runIdRef.current += 1;
    try {
      window.speechSynthesis?.cancel();
    } catch { /* ignore */ }
    onExit?.(pageIdx);
  }, [onExit, pageIdx]);

  const restartPanel = useCallback(() => {
    // Bump the run id so the playback effect restarts on the current panel.
    runIdRef.current += 1;
    setPlaying(false);
    setTimeout(() => setPlaying(true), 0);
  }, []);

  /* ---------- playback loop ---------- */
  useEffect(() => {
    if (!playing || !imgReady || !panels || chapterEnd || titleCard) return;
    if (waitingForOCR) {
      setStatusText(pageIdx === 0 && !spokenCount ? "Reading the text on this page… (first page takes a few seconds)" : "Reading the text on this page…");
      return;
    }
    setStatusText("");
    const myRun = ++runIdRef.current;
    const alive = () => runIdRef.current === myRun;
    const texts = settings.narration && panelTexts ? panelTexts[panelIdx] || [] : [];
    const kind = settingsRef.current.impactCuts ? classifyPanel(currentPanel, texts) : "glide";
    setFx({ type: kind, key: myRun });

    (async () => {
      if (settingsRef.current.sfx) playWhoosh(kind === "impact" ? 0.26 : 0.16);
      let spokeSomething = false;
      if (texts.length) {
        for (const para of texts) {
          if (!alive()) return;
          setSubtitle(para.text);
          const chunks = splitForSpeech(para.text);
          const startedAt = Date.now();
          let engineDead = false;
          for (const chunk of chunks) {
            if (!alive()) return;
            const r = await speakChunk(chunk, { voice: selectedVoice, lang: language, rate: settingsRef.current.rate });
            if (r.why === "end") {
              spokeSomething = true;
            } else if (r.why === "error" && r.error === "not-allowed") {
              setSpeechIssue("not-allowed");
              engineDead = true;
              break;
            } else if (r.why === "nostart" || r.why === "unsupported" || r.why === "end-without-start" || r.why === "error") {
              setSpeechIssue((prev) => prev || (r.why === "error" ? `error: ${r.error}` : "silent"));
              engineDead = true; // skip the rest of this panel's audio; the next panel tries again
              break;
            }
          }
          if (!alive()) return;
          if (engineDead) {
            // Engine isn't producing audio: give readers time to read the subtitle instead.
            const words = para.text.split(/\s+/).length;
            const elapsed = Date.now() - startedAt;
            await wait(Math.max(0, Math.min(6000, 900 + words * 260) - elapsed));
          } else {
            await wait(220);
          }
        }
        if (spokeSomething) {
          setSpeechIssue("");
          setSpokenCount((c) => c + 1);
        }
        await wait(500);
      } else {
        setSubtitle("");
        await wait(Math.max(1.5, settingsRef.current.dwell) * 1000);
      }
      if (!alive()) return;
      setSubtitle("");
      goNextPanel();
    })();

    return () => {
      if (runIdRef.current === myRun) runIdRef.current += 1;
      try {
        window.speechSynthesis?.cancel();
      } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, imgReady, panels, panelIdx, chapterEnd, titleCard, waitingForOCR, panelTexts, settings.narration]);

  /* ---------- camera FX: drift / punch / impact ---------- */
  useEffect(() => {
    const el = driftRef.current;
    if (!el || typeof el.animate !== "function") return;
    const anims = [];
    if (fx.type === "impact") {
      anims.push(el.animate(
        [{ transform: "scale(1.12)", offset: 0 }, { transform: "scale(1)", offset: 0.08 }, { transform: "scale(1.045)", offset: 1 }],
        { duration: 9000, easing: "ease-out", fill: "forwards" },
      ));
      const sh = shakeRef.current;
      if (sh?.animate) {
        anims.push(sh.animate(
          [0, 1, 2, 3, 4, 5, 6].map((i) => ({ transform: i === 6 ? "translate(0,0)" : `translate(${(Math.random() - 0.5) * 22}px, ${(Math.random() - 0.5) * 16}px)` })),
          { duration: 380, easing: "ease-out" },
        ));
      }
    } else if (fx.type === "punch") {
      anims.push(el.animate(
        [{ transform: "scale(1.06)", offset: 0 }, { transform: "scale(1)", offset: 0.12 }, { transform: "scale(1.045)", offset: 1 }],
        { duration: 9000, easing: "ease-out", fill: "forwards" },
      ));
      const sh = shakeRef.current;
      if (sh?.animate) {
        anims.push(sh.animate(
          [{ transform: "translate(0,0)" }, { transform: "translate(6px,-4px)" }, { transform: "translate(-5px,3px)" }, { transform: "translate(0,0)" }],
          { duration: 260, easing: "ease-out" },
        ));
      }
    } else {
      anims.push(el.animate([{ transform: "scale(1)" }, { transform: "scale(1.045)" }], { duration: 9000, easing: "ease-out", fill: "forwards" }));
    }
    return () => anims.forEach((a) => a.cancel());
  }, [fx]);

  /* ---------- end of chapter countdown ---------- */
  useEffect(() => {
    if (!chapterEnd) return;
    setCountdown(8);
    if (!hasNextChapter) return;
    const iv = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(iv);
          try {
            window.sessionStorage.setItem(IMMERSIVE_RESUME_KEY, "1");
          } catch { /* ignore */ }
          goToNextChapter?.();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [chapterEnd, hasNextChapter, goToNextChapter]);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      switch (e.key) {
        case "Escape":
          if (showHelp) setShowHelp(false);
          else if (showSettings) setShowSettings(false);
          else if (!document.fullscreenElement) exit();
          break;
        case " ":
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        case "ArrowRight":
          e.preventDefault();
          setPlaying(false);
          goNextPanel();
          break;
        case "ArrowLeft":
          e.preventDefault();
          setPlaying(false);
          goPrevPanel();
          break;
        case "ArrowDown":
        case "PageDown":
          e.preventDefault();
          goNextPage();
          break;
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          goPrevPage();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "n":
        case "N":
          updateSettings({ narration: !settingsRef.current.narration });
          break;
        case "s":
        case "S":
          setShowSettings((v) => !v);
          break;
        case "?":
        case "h":
        case "H":
          setShowHelp((v) => !v);
          break;
        default:
          return;
      }
      pokeUI();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit, goNextPanel, goPrevPanel, goNextPage, goPrevPage, toggleFullscreen, updateSettings, pokeUI, showHelp, showSettings]);

  /* ---------- camera ---------- */
  const letterboxPx = settings.letterbox ? Math.round(viewport.h * 0.07) : 0;
  const camera = useMemo(() => {
    const imgEl = imgRef.current;
    const nw = imgEl?.naturalWidth || 0;
    const nh = imgEl?.naturalHeight || 0;
    const { w: W, h: H } = viewport;
    if (!nw || !nh || !W || !H || !imgReady) return null;
    const rect = currentPanel || { x: 0, y: 0, w: nw, h: nh };
    const fit = Math.min(W / nw, H / nh);
    const framing = settings.framing === "tight" ? 0.02 : settings.framing === "wide" ? 0.12 : 0.06;
    const padX = W * framing;
    const padY = H * (framing + 0.02) + letterboxPx;
    let s = Math.min((W - 2 * padX) / rect.w, (H - 2 * padY) / rect.h);
    const cap = Math.max(fit, Math.min(settings.framing === "tight" ? 2 : 1.6, fit * 3));
    s = Math.min(s, cap);
    const tx = (W - rect.w * s) / 2 - rect.x * s;
    const ty = (H - rect.h * s) / 2 - rect.y * s;
    return { s, tx, ty, nw, nh, rect };
  }, [viewport, imgReady, currentPanel, settings.framing, letterboxPx]);

  const chapterLabel = chapterInfo?.chapter ? `Chapter ${chapterInfo.chapter}` : "Oneshot";
  const panelCount = panels?.length || 0;
  const backdrop = currentUrl || "";
  const cover = mangaInfo?.coverImageUrl || "";
  const transition = fx.type === "impact" ? "0s" : fx.type === "punch" ? PUNCH : GLIDE;

  let ocrLabel = "";
  if (settings.narration) {
    if (ocr === "failed") ocrLabel = `narration off: ${ocrErrors[currentUrl] || "text detection failed"}`;
    else if (Array.isArray(ocr) && ocr.length === 0) ocrLabel = "no text on this page";
  }

  const speedLines = useMemo(() => {
    const lines = [];
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2 + Math.random() * 0.08;
      const r0 = 18 + Math.random() * 14;
      const r1 = 58 + Math.random() * 12;
      lines.push(`M${50 + Math.cos(a) * r0},${50 + Math.sin(a) * r0} L${50 + Math.cos(a) * r1},${50 + Math.sin(a) * r1}`);
    }
    return lines.join(" ");
  }, []);

  return (
    <div
      ref={stageRef}
      className="fixed inset-0 z-[9999] bg-black text-white select-none overflow-hidden font-sans"
      onMouseMove={pokeUI}
      onTouchStart={pokeUI}
      onClick={() => {
        if (speechIssue === "not-allowed") {
          setSpeechIssue("");
          restartPanel();
          return;
        }
        setPlaying((p) => !p);
        pokeUI();
      }}
    >
      <style>{`
        @keyframes imFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes imTitleIn { 0% { opacity: 0; transform: translateY(24px) scale(.96); letter-spacing: .5em; } 22% { opacity: 1; transform: none; letter-spacing: .06em; } 80% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes imTitleSub { 0% { opacity: 0; } 35% { opacity: 0; } 50% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes imFlash { 0% { opacity: .95; } 100% { opacity: 0; } }
        @keyframes imLines { 0% { opacity: .85; transform: scale(.7); } 100% { opacity: 0; transform: scale(1.35); } }
        @keyframes imGrain { 0% { background-position: 0 0; } 20% { background-position: -35px 20px; } 40% { background-position: 25px -40px; } 60% { background-position: -20px -25px; } 80% { background-position: 40px 15px; } 100% { background-position: 0 0; } }
        @keyframes imBars { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @keyframes imPulse { 0%,100% { opacity: .6; } 50% { opacity: 1; } }
      `}</style>

      {/* Blurred page as ambient backdrop */}
      {backdrop && (
        <div
          className="absolute inset-0 bg-center bg-cover"
          style={{ backgroundImage: `url("${backdrop}")`, filter: "blur(28px) brightness(0.32) saturate(1.3)", transform: "scale(1.15)" }}
        />
      )}

      {/* Shake wrapper -> drift wrapper -> camera */}
      <div ref={shakeRef} className="absolute inset-0">
        <div ref={driftRef} className="absolute inset-0" style={{ transformOrigin: "50% 50%" }}>
          <div
            className="absolute left-0 top-0 will-change-transform"
            style={{
              width: camera?.nw || "auto",
              height: camera?.nh || "auto",
              transform: camera ? `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.s})` : "translate(-100000px, 0)",
              transformOrigin: "0 0",
              transition: `transform ${transition}`,
            }}
          >
            {currentUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imgRef}
                key={`${currentUrl}|${srcMode}`}
                src={pageSrc(currentUrl, srcMode)}
                crossOrigin={srcMode === "direct" ? "anonymous" : undefined}
                alt={`Page ${pageIdx + 1}`}
                draggable={false}
                onLoad={handleImageLoad}
                onError={handleImageError}
                className="block max-w-none rounded-sm shadow-2xl"
              />
            )}
            {camera && settings.spotlight && (
              <div
                className="absolute rounded-[3px] pointer-events-none"
                style={{
                  left: camera.rect.x,
                  top: camera.rect.y,
                  width: camera.rect.w,
                  height: camera.rect.h,
                  boxShadow: "0 0 0 200000px rgba(0,0,0,0.62)",
                  transition: `left ${transition}, top ${transition}, width ${transition}, height ${transition}`,
                }}
              />
            )}
            {camera && settings.showPanels && panels?.map((r, i) => (
              <div
                key={i}
                className="absolute pointer-events-none"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h, border: `${Math.max(2, 3 / camera.s)}px solid ${i === panelIdx ? "#a78bfa" : "rgba(255,80,80,0.9)"}` }}
              >
                <span className="absolute left-1 top-1 px-1.5 rounded bg-black/70 font-bold" style={{ fontSize: Math.max(12, 18 / camera.s), color: i === panelIdx ? "#a78bfa" : "#ff6b6b" }}>{i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Impact FX: flash + speed lines */}
      {fx.type === "impact" && (
        <React.Fragment key={fx.key}>
          <div className="absolute inset-0 bg-white pointer-events-none" style={{ animation: "imFlash 0.16s ease-out forwards" }} />
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ animation: "imLines 0.42s ease-out forwards", transformOrigin: "50% 50%" }}>
            <path d={speedLines} stroke="white" strokeWidth="0.35" strokeLinecap="round" fill="none" opacity="0.9" />
          </svg>
        </React.Fragment>
      )}

      {/* Film grain + vignette */}
      {settings.grain && noise && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: `url(${noise})`, backgroundSize: "200px 200px", opacity: 0.11, mixBlendMode: "overlay", animation: "imGrain 0.6s steps(6) infinite" }}
        />
      )}
      <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(0,0,0,0.6) 100%)" }} />

      {/* Letterbox bars */}
      {settings.letterbox && (
        <>
          <div className="absolute top-0 inset-x-0 bg-black pointer-events-none" style={{ height: letterboxPx, transformOrigin: "top", animation: "imBars 0.6s ease-out" }} />
          <div className="absolute bottom-0 inset-x-0 bg-black pointer-events-none" style={{ height: letterboxPx, transformOrigin: "bottom", animation: "imBars 0.6s ease-out" }} />
        </>
      )}

      {/* Loading / status */}
      {(!imgReady || statusText) && !chapterEnd && !titleCard && (
        <div className="absolute inset-x-0 top-[46%] flex justify-center pointer-events-none">
          <div className="flex items-center gap-3 px-5 py-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-sm tracking-wide">
            <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
            <span>{statusText || "Loading page…"}</span>
          </div>
        </div>
      )}

      {/* Speech blocked banner */}
      {speechIssue && settings.narration && !chapterEnd && (
        <div className="absolute inset-x-0 top-[38%] flex justify-center pointer-events-none">
          <div className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-amber-500/15 backdrop-blur-md border border-amber-300/30 text-sm text-amber-100 max-w-lg text-center" style={{ animation: "imPulse 2s ease-in-out infinite" }}>
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              {speechIssue === "not-allowed"
                ? "Your browser blocked audio until you interact with the page. Click anywhere to start narration."
                : "Narration isn't producing sound yet (subtitles still work). It keeps retrying; if it stays silent, pick another voice in Settings (S) and press Test voice."}
            </span>
          </div>
        </div>
      )}

      {/* Title card */}
      {titleCard && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer overflow-hidden"
          onClick={(e) => { e.stopPropagation(); setTitleCard(false); }}
        >
          <div className="absolute inset-0 bg-center bg-cover" style={{ backgroundImage: cover ? `url("${cover}")` : undefined, filter: "blur(18px) brightness(0.35) saturate(1.4)", transform: "scale(1.2)" }} />
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/30 to-black/80" />
          <div className="relative text-center px-6">
            <div className="text-xs md:text-sm uppercase tracking-[0.4em] text-violet-300" style={{ animation: "imTitleSub 2.8s ease-in-out forwards" }}>
              {mangaInfo?.title || "Immersive Mode"}
            </div>
            <div className="mt-3 text-5xl md:text-8xl font-black tracking-tight" style={{ animation: "imTitleIn 2.8s cubic-bezier(.2,.8,.2,1) forwards", textShadow: "0 8px 40px rgba(0,0,0,.8)" }}>
              {chapterLabel}
            </div>
            {chapterInfo?.title && (
              <div className="mt-3 text-lg md:text-2xl text-white/85" style={{ animation: "imTitleSub 2.8s ease-in-out forwards" }}>
                {chapterInfo.title}
              </div>
            )}
            <div className="mt-10 text-[11px] uppercase tracking-[0.3em] text-white/40" style={{ animation: "imTitleSub 2.8s ease-in-out forwards" }}>tap to skip</div>
          </div>
        </div>
      )}

      {/* Subtitles */}
      {settings.subtitles && subtitle && !chapterEnd && (
        <div
          className="absolute inset-x-0 flex justify-center px-6 pointer-events-none transition-all duration-300"
          style={{ bottom: (showUI ? 104 : 28) + letterboxPx }}
        >
          {settings.subtitleStyle === "box" ? (
            <div key={subtitle} className="max-w-3xl text-center text-base md:text-2xl font-semibold leading-snug px-5 py-3 rounded-2xl bg-black/55 backdrop-blur-sm border border-white/10" style={{ animation: "imFadeIn 0.3s ease-out" }}>
              {subtitle}
            </div>
          ) : (
            <div
              key={subtitle}
              className="max-w-4xl text-center font-bold leading-snug"
              style={{
                fontSize: "clamp(18px, 2.4vw, 32px)",
                letterSpacing: "0.01em",
                textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 3px 14px rgba(0,0,0,.95)",
                animation: "imFadeIn 0.3s ease-out",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}

      {/* End of chapter */}
      {chapterEnd && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="text-xs uppercase tracking-[0.4em] text-violet-300">End of</div>
          <div className="mt-2 text-4xl md:text-6xl font-black">{chapterLabel}</div>
          {hasNextChapter && (
            <div className="relative mt-8 w-20 h-20">
              <svg viewBox="0 0 80 80" className="w-20 h-20 -rotate-90">
                <circle cx="40" cy="40" r="34" stroke="rgba(255,255,255,.12)" strokeWidth="5" fill="none" />
                <circle cx="40" cy="40" r="34" stroke="#a78bfa" strokeWidth="5" fill="none" strokeLinecap="round" strokeDasharray={2 * Math.PI * 34} strokeDashoffset={2 * Math.PI * 34 * (1 - countdown / 8)} style={{ transition: "stroke-dashoffset 1s linear" }} />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-2xl font-bold">{countdown}</div>
            </div>
          )}
          <div className="mt-8 flex flex-wrap gap-3 justify-center">
            {hasNextChapter && (
              <button
                onClick={() => {
                  try {
                    window.sessionStorage.setItem(IMMERSIVE_RESUME_KEY, "1");
                  } catch { /* ignore */ }
                  goToNextChapter?.();
                }}
                className="px-6 py-3 rounded-full bg-violet-600 hover:bg-violet-500 font-semibold shadow-lg shadow-violet-900/50 transition"
              >
                Next chapter now
              </button>
            )}
            <button onClick={() => { setChapterEnd(false); setPageIdx(0); setPanelIdx(0); setPlaying(true); }} className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 font-semibold border border-white/15 transition">
              Replay
            </button>
            <button onClick={exit} className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 font-semibold border border-white/15 transition">
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Progress (story-style segments) */}
      <div className={`absolute inset-x-0 z-10 flex gap-[3px] px-3 transition-all duration-300 ${showUI ? "opacity-100" : "opacity-60"}`} style={{ top: Math.max(8, letterboxPx - 8) }}>
        {pages.map((_, i) => {
          const fill = i < pageIdx ? 1 : i === pageIdx ? (panelCount ? (panelIdx + 1) / panelCount : 0) : 0;
          return (
            <div key={i} className="flex-1 h-[3px] rounded-full bg-white/15 overflow-hidden">
              <div className="h-full bg-violet-300 rounded-full transition-all duration-500" style={{ width: `${fill * 100}%` }} />
            </div>
          );
        })}
      </div>

      {/* Top bar */}
      <div
        className={`absolute inset-x-0 p-4 md:p-6 flex items-start justify-between transition-opacity duration-500 ${showUI ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        style={{ top: Math.max(0, letterboxPx - 6) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.3em] text-violet-300 truncate">{mangaInfo?.title || "Immersive Mode"}</div>
          <div className="text-sm md:text-base font-semibold truncate">
            {chapterLabel}
            {chapterInfo?.title ? ` · ${chapterInfo.title}` : ""}
          </div>
          <div className="text-xs text-white/60 mt-0.5">
            Page {pageIdx + 1}/{pages.length}
            {panelCount ? ` · Panel ${Math.min(panelIdx + 1, panelCount)}/${panelCount}` : ""}
            {ocrLabel ? ` · ${ocrLabel}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowHelp((v) => !v); pokeUI(); }} title="Help (?)" className="p-2.5 rounded-xl bg-black/50 hover:bg-black/70 border border-white/10 backdrop-blur-md"><HelpCircle size={16} /></button>
          <button onClick={toggleFullscreen} title="Fullscreen (F)" className="p-2.5 rounded-xl bg-black/50 hover:bg-black/70 border border-white/10 backdrop-blur-md">
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button onClick={exit} title="Exit immersive mode (Esc)" className="p-2.5 rounded-xl bg-black/50 hover:bg-red-600/70 border border-white/10 backdrop-blur-md"><X size={16} /></button>
        </div>
      </div>

      {/* Bottom controls */}
      <div
        className={`absolute inset-x-0 flex justify-center transition-all duration-500 ${showUI ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        style={{ bottom: 16 + letterboxPx }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 md:gap-1.5 px-3 py-2 rounded-2xl bg-black/60 backdrop-blur-xl border border-white/10 shadow-2xl">
          <Ctl onClick={goPrevPage} title="Previous page (↑)" label="page"><SkipBack size={18} /></Ctl>
          <Ctl onClick={() => { setPlaying(false); goPrevPanel(); }} title="Previous panel (←)" label="panel"><ChevronLeft size={20} /></Ctl>
          <button onClick={() => setPlaying((p) => !p)} title={playing ? "Pause (Space)" : "Play (Space)"} className="mx-1 p-3.5 rounded-full bg-violet-600 hover:bg-violet-500 shadow-lg shadow-violet-900/50 transition">
            {playing ? <Pause size={20} /> : <Play size={20} className="translate-x-[1px]" />}
          </button>
          <Ctl onClick={() => { setPlaying(false); goNextPanel(); }} title="Next panel (→)" label="panel"><ChevronRight size={20} /></Ctl>
          <Ctl onClick={goNextPage} title="Next page (↓)" label="page"><SkipForward size={18} /></Ctl>
          <div className="w-px h-7 bg-white/15 mx-1.5" />
          <Ctl onClick={() => updateSettings({ narration: !settings.narration })} title={settings.narration ? "Narration on (N)" : "Narration off (N)"} label="voice" active={settings.narration}>
            {settings.narration ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </Ctl>
          <Ctl onClick={() => updateSettings({ subtitles: !settings.subtitles })} title="Subtitles" label="subs" active={settings.subtitles}>
            {settings.subtitles ? <Captions size={18} /> : <CaptionsOff size={18} />}
          </Ctl>
          <Ctl onClick={() => updateSettings({ spotlight: !settings.spotlight })} title="Spotlight focus" label="focus" active={settings.spotlight}><Focus size={18} /></Ctl>
          <Ctl onClick={() => updateSettings({ letterbox: !settings.letterbox, grain: !settings.letterbox })} title="Cinematic look (bars + grain)" label="cinema" active={settings.letterbox}><Film size={18} /></Ctl>
          <Ctl onClick={() => { setShowSettings((v) => !v); pokeUI(); }} title="Settings (S)" label="settings" active={showSettings}><Settings size={18} /></Ctl>
        </div>
      </div>

      {/* Help overlay */}
      {showHelp && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={(e) => { e.stopPropagation(); setShowHelp(false); }}>
          <div className="w-[92vw] max-w-md p-6 rounded-2xl bg-black/85 border border-white/10 text-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="font-semibold text-base">Immersive Mode</span>
              <button onClick={() => setShowHelp(false)} className="text-white/60 hover:text-white"><X size={16} /></button>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-white/85">
              {[["Click / Space", "play or pause"], ["← →", "previous / next panel"], ["↑ ↓", "previous / next page"], ["N", "narration on/off"], ["S", "settings"], ["F", "fullscreen"], ["Esc", "exit (twice when fullscreen)"], ["?", "this help"]].map(([k, v]) => (
                <React.Fragment key={k}>
                  <kbd className="px-2 py-0.5 rounded bg-white/10 border border-white/15 font-mono text-xs whitespace-nowrap">{k}</kbd>
                  <span>{v}</span>
                </React.Fragment>
              ))}
            </div>
            <p className="mt-4 text-white/50 text-xs leading-relaxed">Panels are detected on your device; text is read by the OCR engine and spoken by your browser. The gear icon has voices, pacing, framing and effects.</p>
          </div>
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <div
          className="absolute z-20 left-1/2 -translate-x-1/2 w-[94vw] max-w-lg max-h-[70vh] overflow-y-auto p-4 rounded-2xl bg-black/85 backdrop-blur-xl border border-white/10 shadow-2xl text-sm"
          style={{ bottom: 92 + letterboxPx }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-base">Settings</span>
            <button onClick={() => setShowSettings(false)} className="text-white/60 hover:text-white"><X size={16} /></button>
          </div>

          <Section title="Narration">
            <label className="block">
              <span className="text-white/70 text-xs">Voice ({voices.length} available)</span>
              <div className="mt-1 flex gap-2">
                <select
                  className="flex-1 min-w-0 rounded-lg bg-white/10 border border-white/10 px-2 py-1.5 text-sm"
                  value={selectedVoice?.name || ""}
                  onChange={(e) => updateSettings({ voiceName: e.target.value })}
                >
                  {!voices.length && <option value="">No voices found in this browser</option>}
                  {voices.map((v) => (
                    <option key={v.name} value={v.name} className="text-black">{v.name} ({v.lang})</option>
                  ))}
                </select>
                <button
                  onClick={async () => {
                    setSpeechIssue("");
                    setStatusText("Testing voice… (cloud voices can take a few seconds)");
                    const r = await speakChunk("Immersive mode narration test. If you can hear this, narration works.", { voice: selectedVoice, lang: language, rate: settings.rate });
                    setStatusText("");
                    if (r.why !== "end") setSpeechIssue(r.why === "error" ? `error: ${r.error}` : r.why === "nostart" ? "silent" : r.why);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold whitespace-nowrap"
                >
                  Test voice
                </button>
              </div>
            </label>
            <Slider label={`Speed ${settings.rate.toFixed(1)}x`} min={0.6} max={1.8} step={0.1} value={settings.rate} onChange={(v) => updateSettings({ rate: v })} />
            <Slider label={`Seconds per silent panel: ${settings.dwell}s`} min={1.5} max={12} step={0.5} value={settings.dwell} onChange={(v) => updateSettings({ dwell: v })} />
            <Segmented label="Subtitle style" value={settings.subtitleStyle} options={[["anime", "Anime"], ["box", "Boxed"]]} onChange={(v) => updateSettings({ subtitleStyle: v })} />
          </Section>

          <Section title="Camera">
            <Segmented label="Framing" value={settings.framing} options={[["tight", "Tight"], ["normal", "Normal"], ["wide", "Wide"]]} onChange={(v) => updateSettings({ framing: v })} />
            <Segmented
              label="Reading direction"
              value={settings.direction}
              options={[["auto", "Auto"], ["rtl", "Manga →←"], ["ltr", "Comics ←→"]]}
              onChange={(v) => { updateSettings({ direction: v }); setImgReady(false); setPanelsByPage({}); }}
            />
            <Toggle label="Impact cuts on action panels (flash, shake, speed lines)" checked={settings.impactCuts} onChange={(v) => updateSettings({ impactCuts: v })} />
            <Toggle label="Show detected panels (debug outlines)" checked={settings.showPanels} onChange={(v) => updateSettings({ showPanels: v })} />
          </Section>

          <Section title="Look">
            <Toggle label="Letterbox bars" checked={settings.letterbox} onChange={(v) => updateSettings({ letterbox: v })} />
            <Toggle label="Film grain" checked={settings.grain} onChange={(v) => updateSettings({ grain: v })} />
            <Toggle label="Spotlight (dim outside the panel)" checked={settings.spotlight} onChange={(v) => updateSettings({ spotlight: v })} />
            <Toggle label="Sound effects" checked={settings.sfx} onChange={(v) => updateSettings({ sfx: v })} />
          </Section>

          <Section title="Diagnostics">
            <div className="text-xs text-white/70 space-y-1 font-mono">
              <div>text detection: {ocr === "pending" ? "reading…" : ocr === "failed" ? `FAILED (${ocrErrors[currentUrl] || "unknown"})` : Array.isArray(ocr) ? `ok, ${ocr.length} bubbles` : settings.narration ? "not started" : "off"}</div>
              <div>speech engine: {typeof window !== "undefined" && window.speechSynthesis ? `available, ${voices.length} voices` : "NOT supported"}{selectedVoice ? `, using "${selectedVoice.name}"` : ""}</div>
              <div>speech status: {speechIssue ? `problem: ${speechIssue}` : spokenCount ? `ok (${spokenCount} panels spoken)` : "nothing spoken yet"}</div>
              <div>page source: {srcMode === "direct" ? "direct from MangaDex" : "via image optimizer"} · panels: {panelCount}</div>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- UI helpers */

function Ctl({ children, onClick, title, label, active }) {
  return (
    <button onClick={onClick} title={title} className={`group flex flex-col items-center justify-center px-2 py-1 rounded-lg hover:bg-white/10 transition ${active === false ? "text-white/45" : active ? "text-violet-300" : ""}`}>
      {children}
      <span className="mt-0.5 text-[9px] uppercase tracking-wider text-white/40 group-hover:text-white/70">{label}</span>
    </button>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-4">
      <div className="text-[11px] uppercase tracking-[0.25em] text-violet-300 mb-2">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange }) {
  return (
    <label className="block">
      <span className="text-white/70 text-xs">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="w-full accent-violet-500" />
    </label>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div>
      <span className="text-white/70 text-xs">{label}</span>
      <div className="mt-1 flex gap-2">
        {options.map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)} className={`flex-1 px-2 py-1.5 rounded-lg border text-xs ${value === v ? "bg-violet-600 border-violet-400" : "bg-white/5 border-white/10 hover:bg-white/10"}`}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-white/80 text-xs">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-violet-500 w-4 h-4" />
    </label>
  );
}
