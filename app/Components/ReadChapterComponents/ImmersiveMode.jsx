"use client";

/**
 * Immersive Mode: cinematic, panel-by-panel reading with a moving camera,
 * spotlight focus, synchronized narration (OCR + text-to-speech), subtitles
 * and light sound design. Think "manga edit", generated live while you read.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Settings,
  Volume2, VolumeX, Captions, CaptionsOff, Maximize2, Minimize2, Focus, Loader2,
} from "lucide-react";
import { detectPanels, ocrBoxSpace, assignTextToPanels } from "../../util/ReadChapterUtils/detectPanels";
import { playWhoosh, playPageTurn } from "../../util/ReadChapterUtils/immersiveAudio";

const SETTINGS_KEY = "immersiveModeSettings";
export const IMMERSIVE_RESUME_KEY = "immersiveModeResume";

const DEFAULT_SETTINGS = {
  narration: true,     // read panel text aloud (needs OCR)
  subtitles: true,     // show the narrated sentence at the bottom
  spotlight: true,     // dim everything except the current panel
  sfx: true,           // whoosh / page-turn sounds
  rate: 1,             // speech speed
  voiceName: "",       // preferred voice (browser dependent)
  dwell: 4,            // seconds per panel when there is nothing to read
  direction: "auto",   // "auto" | "rtl" | "ltr"
};

const TRANSITION = "1.1s cubic-bezier(0.22, 0.9, 0.25, 1)";

function loadSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function optimizedSrc(url) {
  // Route through Next's image optimizer so the image is same-origin (canvas readable).
  return `/_next/image?url=${encodeURIComponent(url)}&w=1920&q=75`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[|_~^]+/g, "")
    .trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function speak(text, { voice, lang, rate }) {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis || !text) return resolve("skipped");
    const synth = window.speechSynthesis;
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve(why);
    };
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || lang || "en-US";
    utterance.rate = rate;
    utterance.pitch = 1;
    utterance.onend = () => finish("end");
    utterance.onerror = () => finish("error");
    // Some browsers never fire onend (no voices installed, tab throttled). Never get stuck.
    const words = text.split(/\s+/).length;
    const guard = setTimeout(() => finish("timeout"), (words * 520) / rate + 2500);
    try {
      const start = () => synth.speak(utterance);
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(start, 80);
      } else {
        start();
      }
    } catch {
      finish("error");
    }
  });
}

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
  const [ocrByPage, setOcrByPage] = useState({}); // url -> paragraphs[] | "pending" | "failed"
  const [imgReady, setImgReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [subtitle, setSubtitle] = useState("");
  const [showUI, setShowUI] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [voices, setVoices] = useState([]);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [titleCard, setTitleCard] = useState(true);
  const [chapterEnd, setChapterEnd] = useState(false);
  const [countdown, setCountdown] = useState(8);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [statusText, setStatusText] = useState("");

  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const driftRef = useRef(null);
  const runIdRef = useRef(0);
  const uiTimerRef = useRef(null);
  const pendingLastPanelRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const currentUrl = pages[pageIdx];
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

  /* ---------- persistence ---------- */
  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  /* ---------- viewport + fullscreen ---------- */
  useEffect(() => {
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    try {
      window.sessionStorage.removeItem(IMMERSIVE_RESUME_KEY);
    } catch { /* ignore */ }
    // Best effort: the click that opened the mode counts as the user gesture.
    try {
      stageRef.current?.requestFullscreen?.().catch(() => {});
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
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = null;
    };
  }, [language]);

  const selectedVoice = useMemo(() => {
    if (!voices.length) return null;
    return voices.find((v) => v.name === settings.voiceName) || voices.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) || voices[0];
  }, [voices, settings.voiceName]);

  /* ---------- title card ---------- */
  useEffect(() => {
    const t = setTimeout(() => setTitleCard(false), 2600);
    return () => clearTimeout(t);
  }, []);

  /* ---------- auto-hide UI ---------- */
  const pokeUI = useCallback(() => {
    setShowUI(true);
    clearTimeout(uiTimerRef.current);
    uiTimerRef.current = setTimeout(() => {
      if (!showSettings) setShowUI(false);
    }, 3200);
  }, [showSettings]);

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

  // Preload the next page image.
  useEffect(() => {
    const next = pages[pageIdx + 1];
    if (!next) return;
    const img = new Image();
    img.src = optimizedSrc(next);
  }, [pages, pageIdx]);

  /* ---------- OCR (narration) ---------- */
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
      if (!blob) throw new Error("Could not capture page");
      const form = new FormData();
      form.append("file", new File([blob], "page.jpg", { type: "image/jpeg" }));
      form.append("language", language);
      const res = await fetch("/api/readTextAndReplace", { method: "POST", body: form });
      if (!res.ok) throw new Error(`OCR ${res.status}`);
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
          const x = Math.min(...xs) * sx;
          const y = Math.min(...ys) * sy;
          return {
            text: cleanText(p.text),
            x,
            y,
            w: (Math.max(...xs) - Math.min(...xs)) * sx,
            h: (Math.max(...ys) - Math.min(...ys)) * sy,
          };
        })
        .filter((p) => p.text.length > 1 && /[\p{L}\p{N}]/u.test(p.text));
      setOcrByPage((prev) => ({ ...prev, [url]: paragraphs }));
    } catch (err) {
      console.warn("Immersive OCR failed:", err);
      setOcrByPage((prev) => ({ ...prev, [url]: "failed" }));
    }
  }, [language]);

  const handleImageLoad = useCallback(() => {
    const imgEl = imgRef.current;
    const url = currentUrl;
    if (!imgEl || !url) return;
    if (!panelsByPage[url]) {
      setStatusText("Detecting panels…");
      // Let the browser paint the page before crunching pixels.
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
  }, [currentUrl, panelsByPage, ocrByPage, direction, runOCR]);

  // If narration gets switched on later, OCR the current page on demand.
  useEffect(() => {
    if (settings.narration && imgReady && currentUrl && !ocrByPage[currentUrl] && imgRef.current) {
      runOCR(currentUrl, imgRef.current);
    }
  }, [settings.narration, imgReady, currentUrl, ocrByPage, runOCR]);

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
    if (panelIdx > 0) {
      setPanelIdx(panelIdx - 1);
    } else if (pageIdx > 0) {
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

  /* ---------- the playback loop ---------- */
  const waitingForOCR = settings.narration && ocr === "pending";

  useEffect(() => {
    if (!playing || !imgReady || !panels || chapterEnd || titleCard) return;
    if (waitingForOCR) {
      setStatusText("Reading the text on this page…");
      return;
    }
    setStatusText("");
    const myRun = ++runIdRef.current;
    const alive = () => runIdRef.current === myRun;
    const texts = settings.narration && panelTexts ? panelTexts[panelIdx] || [] : [];

    (async () => {
      if (settingsRef.current.sfx) playWhoosh();
      if (texts.length) {
        for (const para of texts) {
          if (!alive()) return;
          setSubtitle(para.text);
          await speak(para.text, { voice: selectedVoice, lang: language, rate: settingsRef.current.rate });
          if (!alive()) return;
          await wait(250);
        }
        await wait(600);
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

  // Slow "Ken Burns" drift, restarted on every panel.
  useEffect(() => {
    const el = driftRef.current;
    if (!el || typeof el.animate !== "function") return;
    const anim = el.animate([{ transform: "scale(1)" }, { transform: "scale(1.045)" }], { duration: 9000, easing: "ease-out", fill: "forwards" });
    return () => anim.cancel();
  }, [pageIdx, panelIdx]);

  // Prefetch OCR for the next page while the current one plays, so narration never waits.
  useEffect(() => {
    if (!settings.narration || !Array.isArray(ocr)) return;
    const nextUrl = pages[pageIdx + 1];
    if (!nextUrl || ocrByPage[nextUrl]) return;
    setOcrByPage((prev) => (prev[nextUrl] ? prev : { ...prev, [nextUrl]: "pending" }));
    const img = new Image();
    img.onload = () => runOCR(nextUrl, img);
    img.onerror = () => setOcrByPage((prev) => ({ ...prev, [nextUrl]: "failed" }));
    img.src = optimizedSrc(nextUrl);
  }, [settings.narration, ocr, pages, pageIdx, ocrByPage, runOCR]);

  // Never wait forever for the OCR service.
  useEffect(() => {
    if (!waitingForOCR || !currentUrl) return;
    const url = currentUrl;
    const t = setTimeout(() => setOcrByPage((prev) => (prev[url] === "pending" ? { ...prev, [url]: "failed" } : prev)), 45000);
    return () => clearTimeout(t);
  }, [waitingForOCR, currentUrl]);

  // Re-detect panels after the reading direction changes (cache was cleared).
  useEffect(() => {
    const imgEl = imgRef.current;
    if (!imgReady && currentUrl && !panelsByPage[currentUrl] && imgEl?.complete && imgEl.naturalWidth) handleImageLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelsByPage]);

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
          if (!document.fullscreenElement) exit();
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
        default:
          return;
      }
      pokeUI();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit, goNextPanel, goPrevPanel, goNextPage, goPrevPage, toggleFullscreen, updateSettings, pokeUI]);

  /* ---------- camera ---------- */
  const camera = useMemo(() => {
    const imgEl = imgRef.current;
    const nw = imgEl?.naturalWidth || 0;
    const nh = imgEl?.naturalHeight || 0;
    const { w: W, h: H } = viewport;
    if (!nw || !nh || !W || !H || !imgReady) return null;
    const rect = currentPanel || { x: 0, y: 0, w: nw, h: nh };
    const fit = Math.min(W / nw, H / nh);
    const padX = W * 0.06;
    const padY = H * 0.08;
    let s = Math.min((W - 2 * padX) / rect.w, (H - 2 * padY) / rect.h);
    const cap = Math.max(fit, Math.min(1.6, fit * 3));
    s = Math.min(s, cap);
    const tx = (W - rect.w * s) / 2 - rect.x * s;
    const ty = (H - rect.h * s) / 2 - rect.y * s;
    return { s, tx, ty, nw, nh, rect };
  }, [viewport, imgReady, currentPanel]);

  const chapterLabel = chapterInfo?.chapter ? `Chapter ${chapterInfo.chapter}` : "Oneshot";
  const panelCount = panels?.length || 0;
  const backdrop = currentUrl ? optimizedSrc(currentUrl) : "";

  return (
    <div
      ref={stageRef}
      className="fixed inset-0 z-[9999] bg-black text-white select-none overflow-hidden font-sans"
      onMouseMove={pokeUI}
      onTouchStart={pokeUI}
      onClick={() => { setPlaying((p) => !p); pokeUI(); }}
    >
      <style>{`
        @keyframes immersiveFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes immersiveTitle { 0% { opacity: 0; letter-spacing: .4em; } 20% { opacity: 1; letter-spacing: .12em; } 80% { opacity: 1; } 100% { opacity: 0; } }
      `}</style>

      {/* Blurred page as ambient backdrop */}
      {backdrop && (
        <div
          className="absolute inset-0 bg-center bg-cover"
          style={{
            backgroundImage: `url("${backdrop}")`,
            filter: "blur(28px) brightness(0.35) saturate(1.3)",
            transform: "scale(1.15)",
          }}
        />
      )}

      {/* Camera stage */}
      <div ref={driftRef} className="absolute inset-0" style={{ transformOrigin: "50% 50%" }}>
        <div
          className="absolute left-0 top-0 will-change-transform"
          style={{
            width: camera?.nw || "auto",
            height: camera?.nh || "auto",
            transform: camera ? `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.s})` : "translate(-100000px, 0)",
            transformOrigin: "0 0",
            transition: `transform ${TRANSITION}`,
          }}
        >
          {currentUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              key={currentUrl}
              src={optimizedSrc(currentUrl)}
              alt={`Page ${pageIdx + 1}`}
              draggable={false}
              onLoad={handleImageLoad}
              onError={() => setStatusText("Could not load this page")}
              className="block max-w-none rounded-sm shadow-2xl"
              style={{ width: camera?.nw || undefined, height: camera?.nh || undefined }}
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
                transition: `left ${TRANSITION}, top ${TRANSITION}, width ${TRANSITION}, height ${TRANSITION}`,
              }}
            />
          )}
        </div>
      </div>

      {/* Vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)" }}
      />

      {/* Loading / status */}
      {(!imgReady || statusText) && !chapterEnd && (
        <div className="absolute inset-x-0 top-[46%] flex justify-center pointer-events-none">
          <div className="flex items-center gap-3 px-5 py-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-sm tracking-wide">
            <Loader2 className="w-4 h-4 animate-spin text-violet-300" />
            <span>{statusText || "Loading page…"}</span>
          </div>
        </div>
      )}

      {/* Title card */}
      {titleCard && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 cursor-pointer" onClick={(e) => { e.stopPropagation(); setTitleCard(false); }}>
          <div className="text-xs md:text-sm uppercase tracking-[0.35em] text-violet-300" style={{ animation: "immersiveTitle 2.6s ease-in-out forwards" }}>
            {mangaInfo?.title || "Immersive Mode"}
          </div>
          <div className="mt-3 text-3xl md:text-6xl font-black tracking-tight" style={{ animation: "immersiveTitle 2.6s ease-in-out forwards" }}>
            {chapterLabel}
          </div>
          {chapterInfo?.title && (
            <div className="mt-2 text-base md:text-xl text-white/80" style={{ animation: "immersiveTitle 2.6s ease-in-out forwards" }}>
              {chapterInfo.title}
            </div>
          )}
        </div>
      )}

      {/* Subtitles */}
      {settings.subtitles && subtitle && !chapterEnd && (
        <div className="absolute inset-x-0 bottom-24 md:bottom-28 flex justify-center px-6 pointer-events-none">
          <div
            key={subtitle}
            className="max-w-3xl text-center text-base md:text-2xl font-semibold leading-snug px-5 py-3 rounded-2xl bg-black/55 backdrop-blur-sm border border-white/10"
            style={{ textShadow: "0 2px 12px rgba(0,0,0,0.9)", animation: "immersiveFadeIn 0.35s ease-out" }}
          >
            {subtitle}
          </div>
        </div>
      )}

      {/* End of chapter */}
      {chapterEnd && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 backdrop-blur-sm" onClick={(e) => e.stopPropagation()}>
          <div className="text-xs uppercase tracking-[0.35em] text-violet-300">End of</div>
          <div className="mt-2 text-3xl md:text-5xl font-black">{chapterLabel}</div>
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
                Next chapter {countdown > 0 ? `in ${countdown}s` : ""}
              </button>
            )}
            <button
              onClick={() => {
                setChapterEnd(false);
                setPageIdx(0);
                setPanelIdx(0);
                setPlaying(true);
              }}
              className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 font-semibold border border-white/15 transition"
            >
              Replay
            </button>
            <button onClick={exit} className="px-6 py-3 rounded-full bg-white/10 hover:bg-white/20 font-semibold border border-white/15 transition">
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div
        className={`absolute top-0 inset-x-0 p-4 md:p-6 flex items-start justify-between transition-opacity duration-500 ${showUI ? "opacity-100" : "opacity-0 pointer-events-none"}`}
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
            {settings.narration && ocr === "failed" ? " · no text found" : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleFullscreen} title="Fullscreen (F)" className="p-2.5 rounded-xl bg-black/50 hover:bg-black/70 border border-white/10 backdrop-blur-md">
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button onClick={exit} title="Exit immersive mode (Esc)" className="p-2.5 rounded-xl bg-black/50 hover:bg-red-600/70 border border-white/10 backdrop-blur-md">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Bottom controls */}
      <div
        className={`absolute bottom-0 inset-x-0 p-4 md:p-6 flex justify-center transition-opacity duration-500 ${showUI ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 md:gap-2 px-3 py-2 rounded-2xl bg-black/55 backdrop-blur-xl border border-white/10 shadow-2xl">
          <button onClick={goPrevPage} title="Previous page (↑)" className="p-2 rounded-lg hover:bg-white/10"><SkipBack size={18} /></button>
          <button onClick={() => { setPlaying(false); goPrevPanel(); }} title="Previous panel (←)" className="p-2 rounded-lg hover:bg-white/10"><ChevronLeft size={20} /></button>
          <button
            onClick={() => setPlaying((p) => !p)}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            className="p-3 rounded-full bg-violet-600 hover:bg-violet-500 shadow-lg shadow-violet-900/50"
          >
            {playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button onClick={() => { setPlaying(false); goNextPanel(); }} title="Next panel (→)" className="p-2 rounded-lg hover:bg-white/10"><ChevronRight size={20} /></button>
          <button onClick={goNextPage} title="Next page (↓)" className="p-2 rounded-lg hover:bg-white/10"><SkipForward size={18} /></button>
          <div className="w-px h-6 bg-white/15 mx-1" />
          <button
            onClick={() => updateSettings({ narration: !settings.narration })}
            title={settings.narration ? "Narration on (N)" : "Narration off (N)"}
            className={`p-2 rounded-lg hover:bg-white/10 ${settings.narration ? "text-violet-300" : "text-white/50"}`}
          >
            {settings.narration ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <button
            onClick={() => updateSettings({ subtitles: !settings.subtitles })}
            title="Subtitles"
            className={`p-2 rounded-lg hover:bg-white/10 ${settings.subtitles ? "text-violet-300" : "text-white/50"}`}
          >
            {settings.subtitles ? <Captions size={18} /> : <CaptionsOff size={18} />}
          </button>
          <button
            onClick={() => updateSettings({ spotlight: !settings.spotlight })}
            title="Spotlight focus"
            className={`p-2 rounded-lg hover:bg-white/10 ${settings.spotlight ? "text-violet-300" : "text-white/50"}`}
          >
            <Focus size={18} />
          </button>
          <button
            onClick={() => { setShowSettings((v) => !v); pokeUI(); }}
            title="Settings"
            className={`p-2 rounded-lg hover:bg-white/10 ${showSettings ? "text-violet-300" : ""}`}
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div
          className="absolute bottom-24 md:bottom-28 left-1/2 -translate-x-1/2 w-[92vw] max-w-sm p-4 rounded-2xl bg-black/80 backdrop-blur-xl border border-white/10 shadow-2xl text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold">Immersive settings</span>
            <button onClick={() => setShowSettings(false)} className="text-white/60 hover:text-white"><X size={16} /></button>
          </div>
          <div className="space-y-3">
            <label className="block">
              <span className="text-white/70 text-xs">Voice</span>
              <select
                className="mt-1 w-full rounded-lg bg-white/10 border border-white/10 px-2 py-1.5 text-sm"
                value={selectedVoice?.name || ""}
                onChange={(e) => updateSettings({ voiceName: e.target.value })}
              >
                {!voices.length && <option value="">No voices available in this browser</option>}
                {voices.map((v) => (
                  <option key={v.name} value={v.name} className="text-black">{v.name} ({v.lang})</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-white/70 text-xs">Narration speed: {settings.rate.toFixed(1)}x</span>
              <input type="range" min="0.6" max="1.8" step="0.1" value={settings.rate} onChange={(e) => updateSettings({ rate: parseFloat(e.target.value) })} className="w-full accent-violet-500" />
            </label>
            <label className="block">
              <span className="text-white/70 text-xs">Seconds per silent panel: {settings.dwell}s</span>
              <input type="range" min="1.5" max="12" step="0.5" value={settings.dwell} onChange={(e) => updateSettings({ dwell: parseFloat(e.target.value) })} className="w-full accent-violet-500" />
            </label>
            <div>
              <span className="text-white/70 text-xs">Reading direction</span>
              <div className="mt-1 flex gap-2">
                {[["auto", "Auto"], ["rtl", "Manga (right → left)"], ["ltr", "Comics / webtoon"]].map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => { updateSettings({ direction: value }); setImgReady(false); setPanelsByPage({}); }}
                    className={`flex-1 px-2 py-1.5 rounded-lg border text-xs ${settings.direction === value ? "bg-violet-600 border-violet-400" : "bg-white/5 border-white/10 hover:bg-white/10"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between">
              <span className="text-white/70 text-xs">Sound effects</span>
              <input type="checkbox" checked={settings.sfx} onChange={(e) => updateSettings({ sfx: e.target.checked })} className="accent-violet-500 w-4 h-4" />
            </label>
            <div className="text-[11px] text-white/45 leading-relaxed pt-1 border-t border-white/10">
              Space play/pause · ←/→ panel · ↑/↓ page · N narration · F fullscreen · Esc exit
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
