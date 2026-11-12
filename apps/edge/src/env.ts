import type { GameHub } from "./hub";

export interface Env {
  GAME_HUB: DurableObjectNamespace<GameHub>;
  ASSETS: Fetcher;
  /** "fake" (the scripted offline DM, the default), "gemini" or "anthropic". */
  AEDM_LLM_PROVIDER?: string;
  /** Secret. Set with `wrangler secret put GEMINI_API_KEY`. */
  GEMINI_API_KEY?: string;
  /** Secret. Set with `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY?: string;
  /** Optional model overrides per tier (plain variables). */
  AEDM_GEMINI_MODEL_FAST?: string;
  AEDM_GEMINI_MODEL_STANDARD?: string;
  AEDM_GEMINI_MODEL_STRONG?: string;
  /** Gemini 3 thinking level: minimal, low (default), medium, high, or off. */
  AEDM_GEMINI_THINKING?: string;
  AEDM_DEV_LOG?: string;
}
