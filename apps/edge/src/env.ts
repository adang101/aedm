import type { GameHub } from "./hub";

export interface Env {
  GAME_HUB: DurableObjectNamespace<GameHub>;
  ASSETS: Fetcher;
  /** "fake" (the scripted offline DM, the default) or "anthropic". */
  AEDM_LLM_PROVIDER?: string;
  /** Secret. Set with `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY?: string;
  AEDM_DEV_LOG?: string;
}
