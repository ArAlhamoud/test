/**
 * Where you stopped reading, per manga, in this browser.
 *
 * Kept deliberately small and self-contained (localStorage, one key) so it can
 * be read from the reader, the immersive player and the landing page without
 * touching the larger manga context.
 */

const KEY = "readerProgress";
const MAX_ENTRIES = 60;

function readAll() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    const entries = Object.values(all)
      .filter((e) => e && e.mangaId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_ENTRIES);
    const trimmed = {};
    for (const e of entries) trimmed[e.mangaId] = e;
    window.localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch { /* quota or private mode: progress is a convenience, never fatal */ }
}

/**
 * Record the current position. Only the fields you pass are updated, so the
 * reader can save the page while immersive mode also saves the panel.
 */
export function saveProgress(entry) {
  if (typeof window === "undefined" || !entry?.mangaId || !entry?.chapterId) return;
  const all = readAll();
  const prev = all[entry.mangaId];
  const sameChapter = prev && prev.chapterId === entry.chapterId;
  all[entry.mangaId] = {
    ...(sameChapter ? prev : {}),
    ...entry,
    // A new chapter resets the panel unless one was given.
    panel: entry.panel ?? (sameChapter ? prev.panel : 0) ?? 0,
    updatedAt: Date.now(),
  };
  writeAll(all);
}

export function getProgress(mangaId) {
  if (!mangaId) return null;
  return readAll()[mangaId] || null;
}

/** Progress for a chapter, or null when the saved position is in another chapter. */
export function getChapterProgress(mangaId, chapterId) {
  const entry = getProgress(mangaId);
  return entry && entry.chapterId === chapterId ? entry : null;
}

/** Most recently read manga across the library, for a "continue reading" entry point. */
export function getMostRecentProgress() {
  const entries = Object.values(readAll()).filter((e) => e && e.chapterId);
  if (!entries.length) return null;
  return entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
}

export function clearProgress(mangaId) {
  const all = readAll();
  if (mangaId) delete all[mangaId];
  writeAll(mangaId ? all : {});
}
