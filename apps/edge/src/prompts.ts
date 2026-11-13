import abilityForge from "../../../packages/llm/prompts/ability-forge.md";
import abilitySchema from "../../../packages/llm/prompts/ability-schema.md";
import dmSystem from "../../../packages/llm/prompts/dm-system.md";
import enemyBuilder from "../../../packages/llm/prompts/enemy-builder.md";
import repair from "../../../packages/llm/prompts/repair.md";
import spriteDesigner from "../../../packages/llm/prompts/sprite-designer.md";
import storyBible from "../../../packages/llm/prompts/story-bible.md";
import storySoFar from "../../../packages/llm/prompts/story-so-far.md";
import summary from "../../../packages/llm/prompts/summary.md";

/** Every file in packages/llm/prompts, keyed by name. test/prompts.test.ts fails if one is missing here. */
export const PROMPTS: Record<string, string> = {
  "ability-forge": abilityForge,
  "ability-schema": abilitySchema,
  "dm-system": dmSystem,
  "enemy-builder": enemyBuilder,
  repair,
  "sprite-designer": spriteDesigner,
  "story-bible": storyBible,
  "story-so-far": storySoFar,
  summary,
};
