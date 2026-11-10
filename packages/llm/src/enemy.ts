import { CONDITIONS, DAMAGE_TYPES, EnemyDraftSchema, type EnemyDraft, type EnemyRole } from "@aedm/schemas";
import { escapeUntrusted } from "./context";
import { LlmError } from "./errors";
import { abilitySchemaText } from "./forge";
import { completeWithRepair, type CallOptions } from "./pipeline";
import type { ModelProvider } from "./provider";
import { loadPrompt, renderTemplate } from "./template";

export interface EnemyRanges {
  hp: [number, number];
  defense: [number, number];
  attackBonus: [number, number];
  damagePerRound: [number, number];
}

export interface EnemyInput {
  concept: string;
  role: EnemyRole;
  settingNotes: string;
  partyLevel: number;
  ranges: EnemyRanges;
}

/** What the engine's enemy finalizer (stat clamping, threat, id) answers. */
export type EnemyFinalizeResult<T> = { ok: true; enemy: T; notes: string[] } | { ok: false; errors: string[] };

export interface EnemyResult<T> {
  enemy: T;
  notes: string[];
  repaired: boolean;
}

const range = (r: [number, number]) => `${r[0]} to ${r[1]}`;

export function buildEnemyPrompt(input: EnemyInput): { system: string; user: string } {
  const system = renderTemplate(loadPrompt("enemy-builder"), {
    ability_schema: abilitySchemaText(),
    damage_types: DAMAGE_TYPES.join(", "),
    conditions: CONDITIONS.join(", "),
    party_level: input.partyLevel,
    hp_range: range(input.ranges.hp),
    def_range: range(input.ranges.defense),
    atk_range: range(input.ranges.attackBonus),
    dmg_range: range(input.ranges.damagePerRound),
  });
  const user = [
    `<enemy_concept>\n${escapeUntrusted(input.concept, 400)}\n</enemy_concept>`,
    `<role>${input.role}</role>`,
    `<setting_notes>\n${escapeUntrusted(input.settingNotes, 400)}\n</setting_notes>`,
  ].join("\n");
  return { system, user };
}

export async function buildEnemy<T>(
  provider: ModelProvider,
  input: EnemyInput,
  deps: { finalize: (draft: EnemyDraft) => EnemyFinalizeResult<T> },
  opts: CallOptions = {},
): Promise<EnemyResult<T>> {
  const { system, user } = buildEnemyPrompt(input);
  let final: Extract<EnemyFinalizeResult<T>, { ok: true }> | undefined;
  const outcome = await completeWithRepair(
    provider,
    { tier: "fast", system, messages: [{ role: "user", content: user }], purpose: "enemy" },
    EnemyDraftSchema,
    opts,
    (draft) => {
      const f = deps.finalize(draft);
      if (!f.ok) return f.errors.map((e) => `- engine: ${e}`).join("\n");
      final = f;
      return undefined;
    },
  );
  if (!outcome.ok || !final) {
    throw new LlmError(`Enemy builder failed: ${outcome.ok ? "no result" : outcome.errors}`, "invalid_output", true);
  }
  return { enemy: final.enemy, notes: final.notes, repaired: outcome.repaired };
}
