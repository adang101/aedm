import { abilityCost, abilityCostGuide, abilitySummary, clampAbilityToLevel, levelCaps, validateAbilityForLevel } from "@aedm/engine";
import { forgeAbility, LlmError, type FinalizeResult, type ForgeInput, type ModelProvider } from "@aedm/llm";
import { CHECK_TAGS, type Ability, type AbilityDraft, type Character, type CharacterCreate, type StoryBible } from "@aedm/schemas";

export class ForgeError extends Error {}

export interface ForgeOutcome {
  abilities: Ability[];
  /** Plain-text lines for the player: what the forge did, changed or dropped. */
  notices: string[];
}

/** What the forge knows about the table beyond the character: the story and the other characters' abilities. */
export interface ForgeContext {
  campaign?: ForgeInput["campaign"];
  party?: NonNullable<ForgeInput["party"]>;
}

const OWN_LABEL = "this character";

/** The story bible as forge context. */
export function bibleCampaign(bible: Pick<StoryBible, "title" | "digest" | "tone">): NonNullable<ForgeInput["campaign"]> {
  return { title: bible.title, digest: bible.digest, tone: bible.tone };
}

/** The room's pitch, used before a bible exists. Nothing when the host wrote none. */
export function pitchCampaign(pitch: string): ForgeInput["campaign"] {
  const digest = pitch.trim();
  return digest ? { digest } : undefined;
}

/** Abilities of every character except `selfId`, one entry per ability. */
export function partyAbilities(characters: readonly Character[], selfId?: string): NonNullable<ForgeInput["party"]> {
  return characters
    .filter((c) => c.id !== selfId)
    .flatMap((c) => c.abilities.map((a) => ({ owner: c.name, name: a.name, summary: abilitySummary(a) })));
}

/** The forge's input for one ability: the idea, the level's caps, the budget and the table context. `own` are the character's other abilities. */
function forgeInput(
  concept: string, abilityText: string, level: number, budget: { total: number; target: number },
  ctx: ForgeContext, own: readonly Ability[],
): ForgeInput {
  const caps = levelCaps(level);
  return {
    concept, abilityText, level, allowedTags: CHECK_TAGS,
    caps: { maxAvg: caps.maxAverage, maxRadius: caps.maxRadius, maxDuration: caps.maxConditionTurns },
    budget, costGuide: abilityCostGuide(),
    ...(ctx.campaign ? { campaign: ctx.campaign } : {}),
    party: [...own.map((a) => ({ owner: OWN_LABEL, name: a.name, summary: abilitySummary(a) })), ...(ctx.party ?? [])],
  };
}

/** Engine finalizer: clamp to level 1, re-validate, price. The engine, not the model, owns the numbers. */
export function finalizeAbility(draft: AbilityDraft, level = 1, maxCost?: number): FinalizeResult<Ability> {
  try {
    const { ability, notes } = clampAbilityToLevel(draft, level, maxCost === undefined ? {} : { maxCost });
    const v = validateAbilityForLevel(ability, level);
    if (!v.ok) return { ok: false, errors: v.errors };
    if (maxCost !== undefined && abilityCost(ability) > maxCost) {
      return { ok: false, errors: [`the ability costs ${abilityCost(ability)} but only ${maxCost} power budget is left; make it cheaper`] };
    }
    return { ok: true, ability, cost: abilityCost(ability), notes };
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : "invalid ability"] };
  }
}

/**
 * Turns a CharacterCreate's ability texts (or prebuilt drafts) into level-1 abilities that fit the
 * power budget. Each ability is forged against an even share of what is left, so the engine's clamp and
 * the model's repair shape it to fit. Dropping the last abilities with a notice is only a safety net.
 */
export async function forgeCharacterAbilities(
  provider: ModelProvider,
  create: CharacterCreate,
  opts: { level?: number; context?: ForgeContext; sleep: (ms: number) => Promise<void>; retryBackoffMs: number; onModelError?: (err: unknown) => void },
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
    const texts = create.ability_texts ?? [];
    for (const [i, text] of texts.entries()) {
      const remaining = caps.budget - forged.reduce((n, f) => n + f.cost, 0);
      const target = Math.max(1, Math.floor(remaining / (texts.length - i)));
      let lastErr: unknown;
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try {
          const r = await forgeAbility(
            provider,
            forgeInput(concept, text, level, { total: caps.budget, target }, opts.context ?? {}, forged.map((f) => f.ability)),
            { finalize: (d) => finalizeAbility(d, level, target) },
          );
          forged.push({ ability: r.ability, cost: r.cost });
          notices.push(describe(r.ability, r.cost, forgeLines(r), caps.budget));
          done = true;
        } catch (err) {
          lastErr = err;
          opts.onModelError?.(err);
          if (!(err instanceof LlmError) || !err.retryable) break;
          await opts.sleep(opts.retryBackoffMs);
        }
      }
      if (!done) {
        const why = lastErr instanceof LlmError ? "the forge is unavailable right now. Try again in a moment" : "it could not be shaped into rules. Try rewording it";
        throw new ForgeError(`The forge failed on "${text.slice(0, 40)}": ${why}.`);
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

/**
 * Forge one ability for a level-up. The result is clamped to the character's level and to `maxCost`
 * (the power budget left). `own` are the character's other abilities. Throws ForgeError with a
 * player-facing message when nothing fits.
 */
export async function forgeOneAbility(
  provider: ModelProvider,
  input: { concept: string; text: string; level: number; maxCost: number; own?: readonly Ability[]; context?: ForgeContext },
  opts: { sleep: (ms: number) => Promise<void>; retryBackoffMs: number; onModelError?: (err: unknown) => void },
): Promise<{ ability: Ability; notes: string[] }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await forgeAbility(
        provider,
        forgeInput(
          input.concept.slice(0, 400), input.text, input.level,
          { total: levelCaps(input.level).budget, target: input.maxCost }, input.context ?? {}, input.own ?? [],
        ),
        { finalize: (d) => finalizeAbility(d, input.level, input.maxCost) },
      );
      return { ability: r.ability, notes: forgeLines(r) };
    } catch (err) {
      lastErr = err;
      opts.onModelError?.(err);
      if (!(err instanceof LlmError) || !err.retryable) break;
      await opts.sleep(opts.retryBackoffMs);
    }
  }
  if (lastErr instanceof LlmError && lastErr.kind === "invalid_output") {
    throw new ForgeError(`The forge could not fit that idea into your remaining power budget (${input.maxCost}). Try something simpler or cheaper.`);
  }
  throw new ForgeError(lastErr instanceof LlmError ? "The forge is unavailable right now. Try again in a moment." : "That could not be shaped into rules. Try rewording it.");
}

/** What the forge says to the player: the rejection (if any), then the model's notes and the engine's adjustments. */
function forgeLines(r: { rejected?: string; forgeNotes: string[] }): string[] {
  const notes = r.forgeNotes.map(sentence);
  return r.rejected ? [`The forge could not do this as written (${r.rejected}). It made the closest allowed version.`, ...notes] : notes;
}

/** Engine clamp notes are fragments ("dice reduced from 2d6 to 1d6"); the player reads sentences. */
const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
};

function describe(a: Ability, cost: number, notes: string[], budget: number): string {
  const extra = notes.length ? ` ${notes.join(" ")}` : "";
  return `Forged "${a.name}" (cost ${cost} of ${budget}).${extra}`.slice(0, 1000);
}
