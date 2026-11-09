import { StoryBibleSchema, type StoryBible } from "@aedm/schemas";
import { escapeUntrusted } from "./context";
import { LANTERN_MARSH_BIBLE } from "./default-bible";
import { completeWithRepair, type CallOptions } from "./pipeline";
import type { ModelProvider } from "./provider";
import { loadPrompt } from "./template";

export interface BibleInput {
  pitch: string;
  partyBriefs: string[];
  contentRating: string;
}

/** Generates the story bible. If parsing fails twice, returns the built-in Lantern Marsh bible. Provider errors still throw. */
export async function generateStoryBible(provider: ModelProvider, input: BibleInput, opts: CallOptions = {}): Promise<StoryBible> {
  const user = [
    `<story_pitch>\n${escapeUntrusted(input.pitch, 1500)}\n</story_pitch>`,
    `<party_briefs>\n${input.partyBriefs.map((b) => `- ${escapeUntrusted(b, 300)}`).join("\n")}\n</party_briefs>`,
    `<content_rating>${input.contentRating}</content_rating>`,
  ].join("\n");
  const outcome = await completeWithRepair(
    provider,
    { tier: "standard", system: loadPrompt("story-bible"), messages: [{ role: "user", content: user }], purpose: "bible", maxTokens: 6000 },
    StoryBibleSchema,
    opts,
  );
  return outcome.ok ? outcome.data : structuredClone(LANTERN_MARSH_BIBLE);
}
