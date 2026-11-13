export type Tier = "fast" | "standard" | "strong";

export type ModelPurpose = "dm" | "forge" | "enemy" | "repair" | "bible" | "summary" | "sprite";

/**
 * Output caps per purpose, in tokens. Sized to the largest valid reply of each schema plus a margin, so a runaway
 * reply cannot burn thousands of tokens. They also have to cover hidden thinking tokens on models where those count
 * against the output limit (Gemini: see providers/gemini.ts, default effort "low", a few hundred tokens), so none is
 * set close to the schema's own size.
 * - dm: 150 words of narration (~220 tokens) + dm_notes (~130) + 8 actions; a large generate_map brief is the heavy
 *   case (12 rooms, 8 points of interest, 8 slots, inline materials: ~1,800). Worst case ~2,800, cap 3,500.
 * - forge: one ability is at most ~500 tokens; a rejection adds an alternative (~1,000 total). Cap 1,800.
 * - enemy: stats plus up to 3 abilities, ~1,500 worst case. Cap 2,500.
 * - sprite: a spec is ~250 tokens. Cap 1,000.
 * - summary: 150 words (~220 tokens). Cap 800.
 * - bible: digest (2,000 chars), 4 acts, 7 stages, 12 milestones, 4 quests: ~3,000 worst case. Cap 4,500.
 * - repair: inherits the cap of the call it repairs.
 */
export const MAX_OUTPUT_TOKENS: Readonly<Record<Exclude<ModelPurpose, "repair">, number>> = {
  dm: 3500,
  forge: 1800,
  enemy: 2500,
  sprite: 1000,
  summary: 800,
  bible: 4500,
};

export interface ModelRequest {
  tier: Tier;
  /** Stable instructions. Cached by providers that support it; keep volatile context out of here. */
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  purpose: ModelPurpose;
}

export interface ModelResponse {
  text: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  stopReason?: string;
}

export interface ModelProvider {
  readonly name: string;
  complete(
    req: ModelRequest,
    opts?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<ModelResponse>;
}
