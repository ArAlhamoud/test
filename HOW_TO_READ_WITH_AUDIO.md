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

`npm run dev` is the development server: convenient, but every page is
compiled on demand, so it feels slow. For reading, run the optimized build
instead (takes a couple of minutes the first time, then starts instantly):

```bash
npm run play
```

## Immersive Mode — the "manga edit" experience, live 🎬

This is the mode to use if you want reading to feel like those animated
manga edits: a camera that glides from panel to panel, everything outside the
current panel dimmed, the dialogue read aloud with subtitles, a whoosh on each
cut and a title card per chapter — generated on the fly, no videos to make.

1. Open any chapter in the reader.
2. Click the 🎬 clapperboard button (top-right toolbar) or press **I**.
3. Sit back. It plays automatically: panel → panel → next page → next chapter.

**What happens under the hood:** each page is analysed in your browser to find
the panel boundaries (white or black gutters), then the camera frames each panel
in reading order (right-to-left for manga, left-to-right for manhwa/comics — it
auto-detects, and you can override it in the settings). If narration is on, the
page text is extracted by the built-in OCR engine, matched to its panel, and
read by your browser's voice while the sentence is shown as a subtitle. Panels
with no text stay on screen for a few seconds (adjustable) before moving on.

**Controls**

| Key / button | Action |
|---|---|
| Space, or click anywhere | Play / pause |
| ← / → | Previous / next panel |
| ↑ / ↓ | Previous / next page |
| N | Toggle narration |
| F | Fullscreen |
| Esc | Exit (returns you to the page you were on) |

The gear icon (or **S**) opens settings in four groups: Narration (voice, a
"Test voice" button, speed, seconds per silent panel, subtitle style), Camera
(framing, reading direction, impact cuts), Look (letterbox bars, film grain,
spotlight, sound effects) and Diagnostics. Press **?** for the shortcut list.
Settings are remembered.

**Effects:** panels with big sound-effect lettering get an impact cut (hard cut,
white flash, shake, speed lines); panels with "!" get a punch-in; everything
else glides. The 🎞 button toggles the cinematic look (letterbox + grain).

**If narration is silent**, open Settings → Diagnostics. It shows whether the
text detection (OCR) succeeded for the page and whether the browser's speech
engine produced sound, and the reason when either failed. "Test voice" plays a
sample sentence. If the browser blocked audio, a banner asks for one click.

**Tips**
- Use Chrome or Edge; Edge's "Natural" voices sound best. Pick the voice in the
  gear menu — the list depends on your OS/browser.
- The first page of a session takes a few extra seconds while the OCR engine
  warms up; after that the next page's text is prepared in the background.
- Panel detection works on pages with clean gutters. Full-bleed art or pages
  with no gutters are shown as one shot; very tall webtoon panels are split
  into scrolling shots automatically.
- Narration reads the text in the chapter's language — open an English chapter
  for English narration.

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
