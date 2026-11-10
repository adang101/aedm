import {
  CHECK_TAGS, CharacterCreateSchema, SPRITE_SHAPES, fixtures,
  type AbilityScoreKey, type CharacterCreate, type CheckTag, type SpriteShape,
} from "@aedm/schemas";
import { ACCENT_SWATCHES, BODY_SWATCHES } from "../render/palette";
import { POINT_BUY_BUDGET, baseScores, pointsLeft, type Scores } from "./pointbuy";

export interface CreatorForm {
  name: string;
  title: string;
  description: string;
  key_ability: AbilityScoreKey;
  scores: Scores;
  traits: CheckTag[];
  abilityTexts: string[];
  shape: SpriteShape;
  color: string;
  accent: string;
  glyph: string;
  /** True once the player typed their own glyph, so it stops following the name. */
  glyphTouched: boolean;
}

export const MAX_TRAITS = 2;
export const MAX_ABILITIES = 3;

export function emptyForm(): CreatorForm {
  return {
    name: "", title: "", description: "", key_ability: "str", scores: baseScores(), traits: [],
    abilityTexts: [""], shape: SPRITE_SHAPES[0], color: BODY_SWATCHES[2] ?? "#7cb342", accent: ACCENT_SWATCHES[1] ?? "#f6e8a0",
    glyph: "?", glyphTouched: false,
  };
}

/** First letter or digit of the name, uppercased; "?" when there is none. */
export function autoGlyph(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name.trim());
  return m ? m[0].toUpperCase() : "?";
}

export function toggleTrait(traits: CheckTag[], tag: CheckTag): CheckTag[] {
  if (traits.includes(tag)) return traits.filter((t) => t !== tag);
  return traits.length >= MAX_TRAITS ? traits : [...traits, tag];
}

export type FormErrors = Partial<Record<"name" | "title" | "description" | "scores" | "traits" | "abilities" | "glyph" | "sprite" | "key_ability", string>>;

export type BuildResult = { ok: true; value: CharacterCreate } | { ok: false; errors: FormErrors };

const PATH_TO_FIELD: Record<string, keyof FormErrors> = {
  name: "name", title: "title", description: "description", scores: "scores", trait_tags: "traits",
  ability_texts: "abilities", abilities: "abilities", key_ability: "key_ability", sprite_recipe: "sprite",
};

/** Validate the form and build the `character` payload of claim_character. */
export function buildCreate(form: CreatorForm): BuildResult {
  const errors: FormErrors = {};
  const left = pointsLeft(form.scores);
  if (left !== 0) errors.scores = left > 0 ? `Spend all ${POINT_BUY_BUDGET} points (${left} left).` : `${-left} points over budget.`;
  const texts = form.abilityTexts.map((t) => t.trim()).filter(Boolean);
  if (texts.length === 0) errors.abilities = "Describe at least one ability.";

  const candidate = {
    v: 1,
    name: form.name,
    title: form.title,
    description: form.description,
    key_ability: form.key_ability,
    scores: form.scores,
    trait_tags: form.traits,
    sprite_recipe: { kind: "shape", shape: form.shape, color: form.color, accent: form.accent, glyph: form.glyph.trim() || autoGlyph(form.name) },
    ability_texts: texts,
  };
  const parsed = CharacterCreateSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, second] = issue.path;
      let field = PATH_TO_FIELD[String(head)];
      if (head === "sprite_recipe" && second === "glyph") field = "glyph";
      if (field && !errors[field]) errors[field] = friendly(String(head), issue.message);
    }
    if (Object.keys(errors).length === 0) errors.name = "Something is invalid in this character.";
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}

function friendly(head: string, msg: string): string {
  if (head === "name") return "Give your character a name (1 to 30 characters).";
  if (head === "trait_tags") return "Pick exactly 2 different trait tags.";
  if (head === "ability_texts") return "Each ability needs 1 to 300 characters.";
  return msg;
}

// ---------- premade characters ----------

const PREMADE_TEXTS: Record<string, string[]> = {
  ch_brindle: [
    "Shaped Charge: Plant and detonate a directional charge. It blasts a small area and stuns anyone caught in it.",
    "Tripwire Cache: Lay a hidden tripwire across a corridor. The first enemy to cross it takes a nasty cut.",
    "Smoke Pop: Throw a smoke bomb that blocks sight in a small area for a couple of turns.",
  ],
  ch_tamsin: [
    "Blink Rush: Dash up to four tiles in a line and strike the first enemy I reach.",
    "Feint and Fade: After I attack, I slip away so attackers have trouble hitting me until my next turn.",
    "Slipstream: Give an ally a burst of speed for two turns.",
  ],
  ch_orrin: [
    "Mending Poultice: Press a healing poultice on an adjacent ally to restore a few hit points.",
    "Bitterroot Snare: Roots erupt and hold one enemy in place for two turns.",
    "Fog Lantern: My lantern reveals hidden creatures and traps in a wide area.",
  ],
};

export function premadeForms(): { label: string; form: CreatorForm }[] {
  return fixtures.SPIKE_PARTY.map((c) => {
    const sprite = c.sprite_recipe;
    return {
      label: c.name.split(" ")[0] ?? c.name,
      form: {
        name: c.name, title: c.title, description: c.description, key_ability: c.key_ability, scores: { ...c.scores },
        traits: [...c.trait_tags], abilityTexts: [...(PREMADE_TEXTS[c.id] ?? [])],
        shape: sprite.shape, color: sprite.color, accent: sprite.accent, glyph: sprite.glyph, glyphTouched: true,
      },
    };
  });
}

export { CHECK_TAGS };
