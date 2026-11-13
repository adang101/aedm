import { SpriteSpecDraftSchema, type SpriteSpec, type SpriteSpecDraft } from "@aedm/schemas";
import { completeWithRepair, type CallOptions } from "./pipeline";
import { MAX_OUTPUT_TOKENS, type ModelProvider } from "./provider";
import { buildSpriteDesignerPrompt } from "./sprite-designer";

export interface SpriteDesignRequest {
  concept: string;
  appearance?: string | undefined;
  name: string;
  /** npc role, enemy role, "pc" or "prop". */
  role: string;
  kind: "npc" | "enemy" | "pc" | "prop";
}

export interface SpriteDesignDeps {
  /** The engine's `finalizeSpriteSpec` (snaps colors, drops unknown parts, clamps). Injected: llm never imports the engine. */
  finalize: (draft: SpriteSpecDraft, ctx: { role: string; name: string }) => { spec: SpriteSpec; notes: string[] };
  /** The engine's offline designer; used whenever the model cannot deliver. */
  fallback: () => SpriteSpec;
}

export interface SpriteDesignResult {
  spec: SpriteSpec;
  notes: string[];
  source: "model" | "offline";
}

/**
 * One fast-tier call, parsed with `SpriteSpecDraftSchema`, at most one repair call, then the engine finalizer.
 * Never throws: any failure (bad output twice, provider error, abort, finalizer error) yields the offline design.
 */
export async function designSprite(
  provider: ModelProvider,
  input: SpriteDesignRequest,
  deps: SpriteDesignDeps,
  opts: CallOptions = {},
): Promise<SpriteDesignResult> {
  try {
    const { system, user } = buildSpriteDesignerPrompt({
      concept: input.concept, ...(input.appearance ? { appearance: input.appearance } : {}), role: input.role, name: input.name,
    });
    const outcome = await completeWithRepair(
      provider,
      { tier: "fast", system, messages: [{ role: "user", content: user }], purpose: "sprite", maxTokens: MAX_OUTPUT_TOKENS.sprite },
      SpriteSpecDraftSchema,
      opts,
    );
    if (outcome.ok) {
      const f = deps.finalize(outcome.data, { role: input.role, name: input.name });
      return { spec: f.spec, notes: f.notes, source: "model" };
    }
    return { spec: deps.fallback(), notes: ["sprite designer output was invalid; used the offline designer"], source: "offline" };
  } catch (err) {
    const why = err instanceof Error ? err.name : "error";
    return { spec: deps.fallback(), notes: [`sprite designer unavailable (${why}); used the offline designer`], source: "offline" };
  }
}
