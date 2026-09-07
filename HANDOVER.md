# Handover — AI Manga Reader with Immersive Mode

Written for another assistant (or developer) picking this project up mid-stream.
Everything below is the current, verified state.

---

## 1. What this project is

A fork of [AI_Manga_Reader](https://github.com/AI-Manga-Readers/AI_Manga_Reader)
(MIT, upstream archived) — a Next.js manga reader that pulls chapters from the
public MangaDex API. On top of the original we built **Immersive Mode**: a
cinematic, panel-by-panel player that reads the dialogue aloud, so reading feels
like the animated "manga edits" popular on TikTok.

The owner is a non-developer reading on Windows/Edge and iPhone. Keep changes
end-user visible and avoid asking them to run complex tooling.

| | |
|---|---|
| Repo | `github.com/ArAlhamoud/test` |
| Working branch | `claude/manga-reader-audio-setup-c3da0e` (fast-forwarded into `main`) |
| Production branch | `main` — every push auto-deploys |
| Live site | **https://manga-reader-rho.vercel.app** |
| Vercel project | `manga-reader` (personal account `aralhamoud`) |
| Stack | Next.js 15.5.25 (App Router), React 19, Tailwind, TanStack Query |

> The other Vercel domain (`manga-reader-aralhamouds-projects.vercel.app`) sits
> behind Vercel's login. Use the `manga-reader-rho` one.

---

## 2. Running it

```bash
git clone https://github.com/ArAlhamoud/test.git manga-reader
cd manga-reader
npm install
npm run dev        # development
npm run play       # optimized build, much faster for actual reading
```

Windows notes that already cost us time:

- PowerShell may refuse npm: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`,
  or call `npm.cmd`.
- Keep the folder **out of OneDrive** — syncing `node_modules` makes installs crawl.
- Puppeteer's Chrome download is disabled in `.puppeteerrc.cjs`. It is only used
  by the optional forum-comments scraper, which returns an empty feed and logs a
  single info line when no Chrome is present.

---

## 3. Architecture — the files that matter

### Immersive Mode (the main feature)

| File | Role |
|---|---|
| `app/Components/ReadChapterComponents/ImmersiveMode.jsx` | The whole player: camera, effects, narration loop, settings, diagnostics. ~1300 lines, portaled into `document.body`. |
| `app/util/ReadChapterUtils/detectPanels.js` | Finds panels in a page image and orders them; also maps OCR boxes onto panels. Pure JS, no OpenCV. |
| `app/util/ReadChapterUtils/neuralVoice.js` | Main-thread client for the neural voice: worker protocol, clip cache, Web Audio playback. |
| `app/workers/kokoro.worker.js` | Runs Kokoro TTS off the main thread (WebGPU, else CPU). |
| `app/util/ReadChapterUtils/immersiveAudio.js` | Whoosh / page-turn sounds, synthesized with Web Audio (no assets). |
| `app/util/ReadChapterUtils/readingProgress.js` | "Where I stopped", per manga, in `localStorage`. |
| `app/Components/ContinueReading.jsx` | The card that jumps back into the reader at the saved page. |
| `scripts/copyOrtAssets.mjs` | Copies the ONNX runtime into `public/ort` before dev/build (git-ignored). |

### Reused from upstream

- `app/api/readTextAndReplace/route.ts` — **server-side OCR** (PaddleOCR ONNX via
  `onnxruntime-web` + `sharp`). ~5–6 s and ~500 MB per page. `maxDuration = 60`.
- `scripts/index.js`, `scripts/main.js`, `scripts/models/` — the OCR engine and models.
- `app/api/manga/*` — MangaDex proxy routes.
- `app/(core)/manga/[mangaId]/chapter/[chapterId]/read/page.jsx` — reader page,
  owns `currentIndex` and mounts Immersive Mode.

### How Immersive Mode works, end to end

1. The page image loads **directly from MangaDex** with `crossOrigin="anonymous"`
   (falls back to `/_next/image` when a node lacks CORS, since pixels must be readable).
2. `detectPanels()` runs on a downscaled copy: estimate the paper tone, build an
   ink mask, then a recursive XY-cut on gutters (white gaps, or thin drawn black
   lines at page level). Leaves = panels; tree order = reading order
   (right-to-left for manga, left-to-right for webtoons).
3. The page is POSTed to `/api/readTextAndReplace`. Returned boxes are in the
   detector's tensor space — `ocrBoxSpace()` converts them back to image pixels.
   **Do not skip this**, or overlays land in the wrong place.
4. `assignTextToPanels()` buckets each text box into a panel and orders it.
5. The playback loop shows a panel, speaks its lines, then advances. Next pages
   are preloaded and their OCR prefetched; neural audio is generated a line ahead.

---

## 4. Voices

Two engines, switchable in Settings (**S**) → Narration:

- **Browser** — `speechSynthesis`. Instant, zero download, but Windows' built-in
  voices sound robotic. Edge's "… Online (Natural)" voices are the good ones and
  can take several seconds to start (they are cloud-backed).
- **Natural AI** — [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
  (Apache-2.0) running **on the reader's device** via `kokoro-js` +
  `@huggingface/transformers`. ~90 MB downloaded once from the Hugging Face CDN,
  then cached. WebGPU when available, otherwise CPU. 28 voices; ten are surfaced
  in `NEURAL_VOICES` in `ImmersiveMode.jsx`.

The owner confirmed the natural voice is a large improvement over the browser one.

Design rules that must survive any refactor:

- The browser voice covers anything the neural engine has not produced yet, so
  switching engines or a slow download never blocks reading.
- Synthesis is capped at 12 s per line; after two slow lines the session stops
  using the neural engine and says so in a corner note.
- Nothing that waits on audio may block forever — see the gotchas.

---

## 5. Gotchas that will bite you

1. **`sharp` must match the version Next bundles** (0.34.x). The project was
   pinned to 0.33.5, so two native builds loaded in one process and OCR died on
   Windows with `TypeError: A boolean was expected`. That was the original
   "narration doesn't work" bug.
2. **Vercel refuses to publish Next 15.4.1** (CVE-2025-66478). Stay ≥ 15.5.25.
3. **Threaded WASM hangs without cross-origin isolation.** `onnxruntime-web`
   threads need `SharedArrayBuffer`, which needs COOP/COEP headers this site does
   not set. The worker keeps `numThreads = 1` unless `self.crossOriginIsolated`.
   Setting it higher silently hangs synthesis forever.
4. **A suspended `AudioContext` must never be awaited indefinitely.** On iOS (and
   Chrome before a gesture) playback would hang and freeze the whole reader.
   `playClip()` resolves `"suspended"` quickly instead. Audio is unlocked when
   Immersive Mode opens, since opening it is itself a user gesture.
5. **`speechSynthesis` lies.** It can never fire `onend`, never start, or report
   zero voices. Every call is wrapped in start/end guards.
6. **Panel detection is heuristic and tuned.** Frame trimming only strips
   near-solid bands (≥0.96 ink) so black art bleeding to the page edge is not
   eaten. Drawn-line separators are only honoured at page level, otherwise dark
   hair and shadows split panels. Verify changes with the harness (§6).
7. **Client bundle needs Node stubs.** `next.config.ts` sets
   `resolve.fallback` for `fs`, `path`, `fs/promises`, `onnxruntime-node`, `sharp`.
8. Dev runs on **webpack, not Turbopack** (`next dev`), so dev and build behave
   the same.
9. `localStorage` keys in use: `immersiveModeSettings`, `readerProgress`,
   `chapterList`, `selectedManga`.

---

## 6. How this was tested

There is no test suite. Two throwaway harnesses proved the risky parts, and are
worth recreating rather than trusting a refactor:

- **Panel detection**: a Node script that downloads real chapter pages, runs
  `detectPanelsFromGray()`, and draws numbered boxes onto the image so the result
  can be eyeballed. Validated on three page styles: high-resolution colour scans,
  black-and-white with white gutters, and pencil sketches separated by drawn lines.
- **Neural voice**: headless Chromium (Puppeteer) driving the real app, with the
  Diagnostics panel read out of the DOM. This is how the WASM-threading hang, the
  suspended-audio hang and the synthesis timeout were all found.

Settings → **Diagnostics** is the built-in equivalent: it reports OCR status per
page, the voice engine and device, whether audio actually played, the page source
and the panel count.

---

## 7. What is done

- Immersive Mode: panel camera with glide / punch-in / impact cuts (flash, shake,
  speed lines on sound-effect panels), spotlight dimming, letterbox, film grain,
  chapter title card, story-style progress bar, end-of-chapter countdown.
- Narration with subtitles; ALL-CAPS lettering is spoken as sentences.
- Natural AI voices with on-screen download progress and graceful degradation.
- Resume: page and panel saved per chapter; "Continue reading" cards on the manga
  list and on a series' page; the reader self-heals on cold deep links.
- English-only: MangaDex queries ask for titles with English chapters, and
  chapter lists no longer pull 60+ languages.
- Keyboard: space/click play-pause, ←/→ panel, ↑/↓ page, N narration, S settings,
  F fullscreen, ? help, Esc exit.

---

## 8. Next task — per-character voices (requested, not started)

The owner wants each character to have their own voice.

**Be honest about the hard part:** manga bubbles are not labelled with speakers.
True speaker identification needs character detection plus bubble-tail tracing,
which is out of reach here. What *is* achievable is a heuristic that usually
feels right, and it should be presented that way.

Suggested approach, in order of value for effort:

1. **Narrator vs dialogue.** Caption boxes (rectangular, hard-edged, often at a
   panel's top corner) carry narration; rounded bubbles carry speech. Give
   narration its own voice. A rough classifier: box aspect ratio, position within
   the panel rect, and whether the text region touches a panel edge.
2. **Speaker slots by position.** Within a panel, cluster text boxes by
   horizontal position (left half / right half, or k-means with k≤3). Bubbles on
   the same side usually belong to the same character in a two-shot. Assign
   slot 0/1/2 → voice A/B/C.
3. **Turn alternation.** Consecutive bubbles far apart horizontally are almost
   always different speakers; keep alternating so a conversation sounds like one.
4. **Optional cast list.** Let the reader name 2–4 characters per manga and pick
   voices, stored alongside `readerProgress`. Even without real identification,
   stable slot→voice mapping per series feels intentional.

**Where to hook in:**

- `assignTextToPanels()` in `detectPanels.js` already returns ordered paragraph
  objects per panel (`{ text, raw, x, y, w, h }`). Add a `speaker` field there —
  it has the geometry and is already unit-testable without a browser.
- In `ImmersiveMode.jsx`, `speakLine(text)` currently reads
  `settingsRef.current.neuralVoice`. Change it to take the paragraph and choose
  `castVoices[para.speaker] ?? neuralVoice`.
- Prefetching (`prefetchVoice`) must use the *same* voice the line will be spoken
  with, or the cache misses and the audio arrives late. The cache key already
  includes the voice.
- Add a "Cast" section to Settings next to "Narration".

Kokoro voice ids to draw from: `af_heart`, `af_bella`, `af_nicole`, `af_sarah`,
`af_sky`, `am_michael`, `am_fenrir`, `am_puck`, `am_onyx`, `am_echo`, `bf_emma`,
`bm_george`, `bm_fable`, `bm_daniel` (a/b = US/UK, f/m = female/male).

### Other things worth doing

- The dev server logs "43 vulnerabilities" from the upstream ESLint 8 toolchain.
  They do not affect reading. **Do not run `npm audit fix --force`** — it breaks
  the build.
- Colourisation of black-and-white pages was discussed and deliberately skipped:
  no model runs fast enough in a browser. MangaDex's own "Official Colored"
  editions are the practical answer.
- Japanese audio with English subtitles ("anime mode") was sketched: read the raw
  Japanese chapter with the Japanese OCR model, narrate with a Japanese voice, and
  show the translated line as the subtitle. Kokoro's shipped voices are English;
  Japanese would need a different model, likely a small server.

---

## 9. Legal note

Upstream archived this project because it depends on MangaDex, which aggregates
fan translations. The app hosts nothing itself, and this fork is for the owner's
personal reading. Keep it that way: no distribution, and prefer official
platforms (Manga Plus, Viz, BookWalker) where a series is licensed.
