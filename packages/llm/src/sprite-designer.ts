import { catalogVars, escapeUntrusted } from "./context";
import { renderPrompt } from "./template";

export interface SpriteDesignInput {
  concept: string;
  appearance?: string;
  /** npc, enemy, boss, minion, character, prop... */
  role: string;
  name?: string;
}

/** System and user text for the sprite designer call (a fast-tier model call returning a SpriteSpecDraft). */
export function buildSpriteDesignerPrompt(input: SpriteDesignInput): { system: string; user: string } {
  const system = renderPrompt("sprite-designer", catalogVars());
  const user = [
    `<concept>\n${escapeUntrusted(input.concept, 400)}\n</concept>`,
    `<appearance>\n${escapeUntrusted(input.appearance ?? "", 400)}\n</appearance>`,
    `<role>\n${escapeUntrusted(input.role, 40)}\n</role>`,
    ...(input.name ? [`<name>\n${escapeUntrusted(input.name, 60)}\n</name>`] : []),
  ].join("\n");
  return { system, user };
}
