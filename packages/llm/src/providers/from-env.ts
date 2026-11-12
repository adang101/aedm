import type { ModelProvider, Tier } from "../provider";
import { createAnthropicProvider } from "./anthropic";
import { createFakeProvider } from "./fake";
import { GEMINI_THINKING_LEVELS, createGeminiProvider, type GeminiThinkingLevel } from "./gemini";

export const PROVIDER_KINDS = ["fake", "anthropic", "gemini"] as const;

/**
 * Picks the provider from settings (a process environment or a Worker env). Throws a plain-language Error when
 * the choice is unknown or its key is missing. Keys are read here and never logged.
 *   AEDM_LLM_PROVIDER: fake (default) | anthropic | gemini
 *   ANTHROPIC_API_KEY, GEMINI_API_KEY
 *   AEDM_GEMINI_THINKING: minimal | low (default) | medium | high | off (gemini-3 models only)
 *   AEDM_GEMINI_MODEL_FAST / _STANDARD / _STRONG: override the Gemini model for a tier
 */
export function createProviderFromEnv(env: Record<string, string | undefined>): ModelProvider {
  const kind = (env.AEDM_LLM_PROVIDER || "fake").toLowerCase();
  if (kind === "fake") return createFakeProvider();
  if (kind === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("AEDM_LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY.");
    return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY });
  }
  if (kind === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("AEDM_LLM_PROVIDER=gemini needs GEMINI_API_KEY.");
    const models: Partial<Record<Tier, string>> = {};
    if (env.AEDM_GEMINI_MODEL_FAST) models.fast = env.AEDM_GEMINI_MODEL_FAST;
    if (env.AEDM_GEMINI_MODEL_STANDARD) models.standard = env.AEDM_GEMINI_MODEL_STANDARD;
    if (env.AEDM_GEMINI_MODEL_STRONG) models.strong = env.AEDM_GEMINI_MODEL_STRONG;
    const raw = (env.AEDM_GEMINI_THINKING ?? "").trim().toLowerCase();
    let thinkingLevel: GeminiThinkingLevel | null | undefined;
    if (raw === "off") thinkingLevel = null;
    else if (GEMINI_THINKING_LEVELS.includes(raw as GeminiThinkingLevel)) thinkingLevel = raw as GeminiThinkingLevel;
    else if (raw !== "") throw new Error(`Unknown AEDM_GEMINI_THINKING "${raw}". Use ${GEMINI_THINKING_LEVELS.join(", ")} or off.`);
    return createGeminiProvider({ apiKey: env.GEMINI_API_KEY, models, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) });
  }
  throw new Error(`Unknown AEDM_LLM_PROVIDER "${kind}". Use ${PROVIDER_KINDS.join(", ")}.`);
}
