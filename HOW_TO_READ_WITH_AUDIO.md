# How to Read Manga with Audio & Immersion

This repo contains a copy of [AI Manga Reader](https://github.com/AI-Manga-Readers/AI_Manga_Reader)
(MIT licensed), a Next.js manga reader with in-browser AI OCR, translation overlays,
and text-to-speech. The `livedemoimages/` screenshot folder from the original repo
was left out to keep this repo small — everything needed to run the app is here.

## Run it

Requires Node.js 18.17+ (tested with Node 22).

```bash
npm install
npm run dev
```

Open http://localhost:3000 in your browser (Chrome or Edge recommended — see
voice notes below).

## Listen Mode — manga read aloud to you

1. Browse or search (`Ctrl+K` / `Cmd+K`) for a manga and open a chapter.
2. In the reader, click the 🗣️ **Listen** button.
3. The OCR engine scans the panel text; the TTS panel appears.
4. Pick a voice from the dropdown, set speed (0.5x–2.0x), pitch, and volume.
5. Press play — the text is highlighted in sync as it's read, and the reader can
   auto-advance to the next panel/page.

**About the voices:** the app uses your browser's Web Speech API, so the voice
list depends on your OS and browser:

- **Microsoft Edge** has the best free natural-sounding voices (the "Microsoft ...
  Online (Natural)" ones).
- **Chrome** ships Google voices that are solid.
- On Linux, install `espeak-ng` or `speech-dispatcher` voices if the dropdown is empty.

## Translation Mode — read untranslated chapters

1. Open a chapter that's only available in Japanese/Korean/Chinese.
2. Click the 🤖 **Translate** button.
3. Pick source and target languages.
4. The in-browser OCR (PaddleOCR ONNX models in `scripts/models/`, run via
   onnxruntime-web — no external API, no keys) detects the text and overlays
   the translation directly on the speech bubbles.
5. Combine with Listen Mode to have the *translated* text read aloud.

## Immersion tips

- **Reading mode**: in reader settings choose vertical scroll (webtoon style),
  horizontal pages, or double-page spreads.
- **Dark theme** + browser fullscreen (`F11`) for a distraction-free night read.
- **Auto-advance** in the TTS panel turns it into a hands-free "anime lite"
  experience — great while cooking or exercising.
- Bookmarks, favorites, and reading history are saved automatically in the
  Library (stored locally in your browser).

## Important note

The upstream project is **archived/paused** by its author over legal concerns:
it pulls content from MangaDex, which aggregates fan translations in a legal
gray area. Use it for personal/educational purposes, and prefer official
platforms (Viz, Manga Plus, BookWalker, Crunchyroll) to support creators.
