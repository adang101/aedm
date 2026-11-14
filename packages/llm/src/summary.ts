import { escapeUntrusted } from "./context";
import type { CallOptions } from "./pipeline";
import { MAX_OUTPUT_TOKENS, type ModelProvider } from "./provider";
import { loadPrompt } from "./template";

/** Hard caps a little above the word limits the prompts ask for. */
const CHAPTER_WORDS = 160;
const STORY_WORDS = 320;

async function summarize(provider: ModelProvider, prompt: string, user: string, maxWords: number, opts: CallOptions): Promise<string> {
  const res = await provider.complete(
    { tier: "fast", system: loadPrompt(prompt), messages: [{ role: "user", content: user }], purpose: "summary", maxTokens: MAX_OUTPUT_TOKENS.summary },
    opts.signal ? { signal: opts.signal } : {},
  );
  return res.text.trim().split(/\s+/).slice(0, maxWords).join(" ");
}

/** Summarises one batch of turns, and only those turns, into a chapter for the DM's memory. Plain text out. */
export function summarizeChapter(
  provider: ModelProvider,
  input: { turns: { speaker: string; text: string }[] },
  opts: CallOptions = {},
): Promise<string> {
  const turns = input.turns.map((t) => `${t.speaker.replace(/[<>\n]/g, " ")}: ${escapeUntrusted(t.text, 600)}`).join("\n");
  return summarize(provider, "summary", `<turns>\n${turns}\n</turns>`, CHAPTER_WORDS, opts);
}

/** Folds a chapter into the running summary of everything older. Plain text out. */
export function foldIntoStory(
  provider: ModelProvider,
  input: { storySoFar: string; chapter: string },
  opts: CallOptions = {},
): Promise<string> {
  const user = [
    `<story_so_far>\n${escapeUntrusted(input.storySoFar, 2500) || "(none)"}\n</story_so_far>`,
    `<chapter>\n${escapeUntrusted(input.chapter, 1200)}\n</chapter>`,
  ].join("\n");
  return summarize(provider, "story-so-far", user, STORY_WORDS, opts);
}
