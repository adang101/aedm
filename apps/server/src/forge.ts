import { abilityCost, clampAbilityToLevel, levelCaps, validateAbilityForLevel } from "@aedm/engine";
import { forgeAbility, LlmError, type FinalizeResult, type ModelProvider } from "@aedm/llm";
import { CHECK_TAGS, type Ability, type AbilityDraft, type CharacterCreate } from "@aedm/schemas";

export class ForgeError extends Error {}

export interface ForgeOutcome {
  abilities: Ability[];
  /** Plain-text lines for the player: what the forge did, changed or dropped. */
  notices: string[];
}

/** Engine finalizer: clamp to level 1, re-validate, price. The engine, not the model, owns the numbers. */
export function finalizeAbility(draft: AbilityDraft, level = 1): FinalizeResult<Ability> {
  try {
    const { ability, notes } = clampAbilityToLevel(draft, level);
    const v = validateAbilityForLevel(ability, level);
    if (!v.ok) return { ok: false, errors: v.errors };
    return { ok: true, ability, cost: abilityCost(ability), notes };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : "invalid ability"] };
  }
}

/**
 * Turns a CharacterCreate's ability texts (or prebuilt drafts) into level-1 abilities that fit the
 * power budget. Over budget: the last abilities are dropped with a notice (at least one is kept).
 */
export async function forgeCharacterAbilities(
  provider: ModelProvider,
  create: CharacterCreate,
  opts: { level?: number; sleep: (ms: number) => Promise<void>; retryBackoffMs: number },
): Promise<ForgeOutcome> {
  const level = opts.level ?? 1;
  const caps = levelCaps(level);
  const concept = `${create.name}, ${create.title}. ${create.description}`.trim().slice(0, 400);
  const forged: { ability: Ability; cost: number }[] = [];
  const notices: string[] = [];

  if (create.abilities) {
    for (const draft of create.abilities) {
      const f = finalizeAbility(draft, level);
      if (!f.ok) throw new ForgeError(`Ability "${draft.name}" is not allowed: ${f.errors.join("; ")}`);
      forged.push({ ability: f.ability, cost: f.cost });
      notices.push(describe(f.ability, f.cost, f.notes, caps.budget));
    }
  } else {
    for (const text of create.ability_texts ?? []) {
      let lastErr: unknown;
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try {
          const r = await forgeAbility(
            provider,
            {
              concept, abilityText: text, level, allowedTags: CHECK_TAGS,
              caps: { maxAvg: caps.maxAverage, maxRadius: caps.maxRadius, maxDuration: caps.maxConditionTurns },
            },
            { finalize: (d) => finalizeAbility(d, level) },
          );
          forged.push({ ability: r.ability, cost: r.cost });
          const lines = r.rejected ? [`The forge could not do this as written (${r.rejected}). It made the closest allowed version.`, ...r.forgeNotes] : r.forgeNotes;
          notices.push(describe(r.ability, r.cost, lines, caps.budget));
          done = true;
        } catch (err) {
          lastErr = err;
          if (!(err instanceof LlmError) || !err.retryable) break;
          await opts.sleep(opts.retryBackoffMs);
        }
      }
      if (!done) {
        const why = lastErr instanceof LlmError ? "the forge is unavailable right now" : "it could not be shaped into rules";
        throw new ForgeError(`The forge failed on "${text.slice(0, 40)}": ${why}. Try rewording it.`);
      }
    }
  }

  let total = forged.reduce((n, f) => n + f.cost, 0);
  while (total > caps.budget && forged.length > 1) {
    const dropped = forged.pop() as { ability: Ability; cost: number };
    total -= dropped.cost;
    notices.push(`Dropped "${dropped.ability.name}" (cost ${dropped.cost}): your abilities exceeded the level ${level} power budget of ${caps.budget}.`);
  }
  return { abilities: forged.map((f) => f.ability), notices };
}

function describe(a: Ability, cost: number, notes: string[], budget: number): string {
  const extra = notes.length ? ` ${notes.join(" ")}` : "";
  return `Forged "${a.name}" (cost ${cost} of ${budget} budget).${extra}`.slice(0, 1000);
}
