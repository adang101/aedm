import { AbilityDraftSchema, CONDITIONS, DAMAGE_TYPES, TERRAIN_KINDS, type AbilityDraft } from "@aedm/schemas";
import { LlmError } from "./errors";
import { completeWithRepair, type CallOptions, type SafeParser } from "./pipeline";
import { MAX_OUTPUT_TOKENS, type ModelProvider } from "./provider";
import { escapeUntrusted } from "./context";
import { loadPrompt, renderTemplate } from "./template";

/** What the engine's finalizer (cost, clamping, id assignment) answers. Injected: llm never imports the engine. */
export type FinalizeResult<T> = { ok: true; ability: T; cost: number; notes: string[] } | { ok: false; errors: string[] };

export interface ForgeInput {
  concept: string;
  abilityText: string;
  level: number;
  allowedTags: readonly string[];
  caps: { maxAvg: number; maxRadius: number; maxDuration: number };
  /** The story the ability must fit: the bible's digest in a game, the room's pitch in the lobby. */
  campaign?: { title?: string; digest: string; tone?: string };
  /** Abilities already in the party (at most 12 are shown), so the forge can avoid duplicating one. */
  party?: { owner: string; name: string; summary: string }[];
  /** `total` is the character's power budget; `target` is what this ability should stay within. */
  budget?: { total: number; target: number };
  /** Engine-rendered explanation of what makes an ability expensive. */
  costGuide?: string;
}

const MAX_PARTY_ABILITIES = 12;
const MAX_DIGEST = 600;

export interface ForgeResult<T> {
  ability: T;
  cost: number;
  /** The model's forge_notes plus anything the engine changed. */
  forgeNotes: string[];
  /** Set when the idea was impossible; the reason to show the player. `ability` is then the alternative. */
  rejected?: string;
  repaired: boolean;
}

export type ForgeReply = { kind: "draft"; draft: AbilityDraft } | { kind: "rejected"; reason: string; alternative: AbilityDraft };

type Issue = { path: readonly PropertyKey[]; message: string };

/** Accepts an ability draft or {"rejected":true,"reason":...,"alternative":<draft>}. */
export const ForgeReplySchema: SafeParser<ForgeReply> = {
  safeParse(value) {
    const v = value as Record<string, unknown> | null;
    if (v && typeof v === "object" && v.rejected === true) {
      const issues: Issue[] = [];
      if (typeof v.reason !== "string" || v.reason.trim() === "") issues.push({ path: ["reason"], message: "reason must be a non-empty string" });
      const alt = AbilityDraftSchema.safeParse(v.alternative);
      if (!alt.success) issues.push(...alt.error.issues.map((i) => ({ path: ["alternative", ...i.path], message: i.message })));
      if (issues.length || !alt.success) return { success: false, error: { issues } };
      return { success: true, data: { kind: "rejected", reason: String(v.reason).trim().slice(0, 300), alternative: alt.data } };
    }
    const r = AbilityDraftSchema.safeParse(value);
    return r.success
      ? { success: true, data: { kind: "draft", draft: r.data } }
      : { success: false, error: { issues: r.error.issues } };
  },
};

export function abilitySchemaText(): string {
  return renderTemplate(loadPrompt("ability-schema"), {
    damage_types: DAMAGE_TYPES.join(", "),
    conditions: CONDITIONS.join(", "),
    terrain_kinds: TERRAIN_KINDS.join(", "),
  });
}

export function buildForgePrompt(input: ForgeInput): { system: string; user: string } {
  const system = renderTemplate(loadPrompt("ability-forge"), {
    ability_schema: abilitySchemaText(),
    level: input.level,
    max_avg: input.caps.maxAvg,
    max_radius: input.caps.maxRadius,
    max_duration: input.caps.maxDuration,
    allowed_tags: input.allowedTags.join(", "),
  });
  const user = [
    `<character_concept>\n${escapeUntrusted(input.concept, 400)}\n</character_concept>`,
    `<ability_text>\n${escapeUntrusted(input.abilityText, 800)}\n</ability_text>`,
    ...contextSections(input),
  ].join("\n");
  return { system, user };
}

/** The optional tagged sections of the forge's user message. Player and model text is escaped. */
function contextSections({ campaign, party, budget, costGuide }: ForgeInput): string[] {
  const out: string[] = [];
  if (campaign) {
    const lines = [
      campaign.title ? `Title: ${escapeUntrusted(campaign.title, 120)}` : "",
      campaign.tone ? `Tone: ${escapeUntrusted(campaign.tone, 120)}` : "",
      `Story: ${escapeUntrusted(campaign.digest, MAX_DIGEST)}`,
    ].filter(Boolean);
    out.push(`<campaign>\n${lines.join("\n")}\n</campaign>`);
  }
  if (party?.length) {
    const lines = party.slice(0, MAX_PARTY_ABILITIES)
      .map((a) => `- ${escapeUntrusted(a.owner, 60)}: "${escapeUntrusted(a.name, 60)}" (${escapeUntrusted(a.summary, 160)})`);
    out.push(`<party_abilities>\n${lines.join("\n")}\n</party_abilities>`);
  }
  if (budget) {
    out.push(`<budget>\nThe character's total power budget is ${budget.total}. This ability should cost at most ${budget.target}.\n</budget>`);
  }
  if (costGuide) out.push(`<cost_guide>\n${costGuide}\n</cost_guide>`);
  return out;
}

export async function forgeAbility<T>(
  provider: ModelProvider,
  input: ForgeInput,
  deps: { finalize: (draft: AbilityDraft) => FinalizeResult<T> },
  opts: CallOptions = {},
): Promise<ForgeResult<T>> {
  const { system, user } = buildForgePrompt(input);
  let finalized: { reply: ForgeReply; result: Extract<FinalizeResult<T>, { ok: true }> } | undefined;

  const outcome = await completeWithRepair(
    provider,
    { tier: "standard", system, messages: [{ role: "user", content: user }], purpose: "forge", maxTokens: MAX_OUTPUT_TOKENS.forge },
    ForgeReplySchema,
    opts,
    (reply) => {
      const draft = reply.kind === "draft" ? reply.draft : reply.alternative;
      const f = deps.finalize(draft);
      if (!f.ok) return f.errors.map((e) => `- engine: ${e}`).join("\n");
      finalized = { reply, result: f };
      return undefined;
    },
  );
  if (!outcome.ok || !finalized) {
    throw new LlmError(`Ability forge failed: ${outcome.ok ? "no result" : outcome.errors}`, "invalid_output", true);
  }
  const { reply, result } = finalized;
  const draft = reply.kind === "draft" ? reply.draft : reply.alternative;
  const notes = [...(draft.forge_notes ? [draft.forge_notes] : []), ...result.notes];
  return {
    ability: result.ability,
    cost: result.cost,
    forgeNotes: notes,
    ...(reply.kind === "rejected" ? { rejected: reply.reason } : {}),
    repaired: outcome.repaired,
  };
}
