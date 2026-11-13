import { foldIntoStory, summarizeChapter, type ModelProvider } from "@aedm/llm";

/** Chapters kept word for word; the oldest one past this is folded into the story so far. */
export const CHAPTERS_KEPT = 4;

/** The DM's long-term memory: everything older in one summary, then the most recent chapters (oldest first). */
export interface StoryMemory {
  storySoFar: string;
  chapters: string[];
}

export const EMPTY_MEMORY: StoryMemory = { storySoFar: "", chapters: [] };

/**
 * Writes a chapter for `turns` and folds the oldest chapters into the story so far while there are too many.
 * Returns the new memory (the input is not changed), or null when the chapter could not be written, so the
 * caller can keep the turns. A fold that fails leaves the extra chapter for the next call to fold.
 */
export async function absorbTurns(
  provider: ModelProvider,
  memory: StoryMemory,
  turns: { speaker: string; text: string }[],
): Promise<StoryMemory | null> {
  let chapter: string;
  try {
    chapter = await summarizeChapter(provider, { turns });
  } catch {
    return null;
  }
  if (!chapter) return memory;
  const chapters = [...memory.chapters, chapter];
  let storySoFar = memory.storySoFar;
  while (chapters.length > CHAPTERS_KEPT) {
    const folded = await foldIntoStory(provider, { storySoFar, chapter: chapters[0] as string }).catch(() => "");
    if (!folded) break;
    storySoFar = folded;
    chapters.shift();
  }
  return { storySoFar, chapters };
}
