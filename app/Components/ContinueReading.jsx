"use client";

/**
 * "Continue reading" entry point: jumps straight back into the reader at the
 * exact page you stopped on, rather than to the chapter list.
 *
 * Pass a mangaId to show that series only; omit it for the most recent one.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { BookOpen, X } from "lucide-react";
import { getMostRecentProgress, getProgress, clearProgress } from "../util/ReadChapterUtils/readingProgress";

export default function ContinueReading({ mangaId, isDark = true, className = "" }) {
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    // localStorage is only available on the client, so read after mounting.
    setEntry(mangaId ? getProgress(mangaId) : getMostRecentProgress());
  }, [mangaId]);

  if (!entry?.chapterId) return null;

  const page = (entry.page || 0) + 1;
  const total = entry.totalPages || 0;
  const percent = total ? Math.min(100, Math.round((page / total) * 100)) : 0;
  const title = entry.mangaTitle || "Continue reading";

  return (
    <div className={`w-full ${className}`}>
      <div
        className={`group relative flex items-center gap-4 rounded-2xl border p-3 pr-4 backdrop-blur-md transition-colors ${
          isDark ? "bg-purple-950/30 border-white/10 hover:bg-purple-950/50" : "bg-white/70 border-gray-200 hover:bg-white"
        }`}
      >
        <Link
          href={`/manga/${entry.mangaId}/chapter/${entry.chapterId}/read`}
          className="flex flex-1 items-center gap-4 min-w-0"
        >
          {entry.cover ? (
            <Image
              src={entry.cover}
              alt={title}
              width={56}
              height={80}
              className="h-20 w-14 shrink-0 rounded-lg object-cover shadow-lg"
              unoptimized
            />
          ) : (
            <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded-lg bg-white/10">
              <BookOpen size={20} />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className={`text-[11px] uppercase tracking-[0.25em] ${isDark ? "text-violet-300" : "text-purple-600"}`}>
              Continue reading
            </div>
            <div className={`truncate text-sm font-semibold md:text-base ${isDark ? "text-white" : "text-gray-900"}`}>
              {title}
            </div>
            <div className={`mt-0.5 truncate text-xs ${isDark ? "text-white/60" : "text-gray-600"}`}>
              {entry.chapterNum ? `Chapter ${entry.chapterNum}` : "Oneshot"}
              {entry.chapterTitle ? ` · ${entry.chapterTitle}` : ""}
              {total ? ` · page ${page} of ${total}` : ` · page ${page}`}
            </div>
            {total > 0 && (
              <div className={`mt-2 h-1 w-full overflow-hidden rounded-full ${isDark ? "bg-white/10" : "bg-gray-200"}`}>
                <div className="h-full rounded-full bg-violet-400" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>

          <span className="hidden shrink-0 rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-violet-900/40 group-hover:bg-violet-500 sm:block">
            Resume
          </span>
        </Link>

        <button
          onClick={() => {
            clearProgress(entry.mangaId);
            setEntry(mangaId ? null : getMostRecentProgress());
          }}
          title="Remove from continue reading"
          className={`shrink-0 rounded-lg p-1.5 transition-colors ${isDark ? "text-white/40 hover:bg-white/10 hover:text-white" : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"}`}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
