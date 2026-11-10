/**
 * The creator's sprite builder: a body plan, a size, four palette slots and up to four parts, turned into a
 * `SpriteSpec` recipe. Pure and deterministic ("Randomize look" depends only on the name and a counter).
 */
import {
  BODY_PLANS, PART_GROUPS, SpriteSpecSchema,
  type BodyPlan, type Part, type PartGroup, type SpritePalette, type SpriteSpec,
} from "@aedm/schemas";
import { PALETTE, RAMPS, hashString } from "../render/palette";
import { rint, rng } from "../render/px";

export const MAX_BUILDER_PARTS = 4;
export const BUILDER_SIZES = ["small", "medium"] as const;
export type BuilderSize = (typeof BUILDER_SIZES)[number];
export const PALETTE_SLOTS = ["primary", "secondary", "accent", "detail"] as const;
export type PaletteSlot = (typeof PALETTE_SLOTS)[number];

export interface SpriteForm {
  body: BodyPlan;
  size: BuilderSize;
  palette: SpritePalette;
  parts: Part[];
  /** Bumped by "Randomize look", so the same name gives a new look each press. */
  rolls: number;
  /**
   * The designed spec this form was read from ("Describe your look"). While the builder controls still show exactly
   * what the design shows, the design is kept whole (any size, up to six parts, traits, pose); a tweak builds on top of it.
   */
  base?: SpriteSpec;
}

export const SLOT_LABEL: Record<PaletteSlot, string> = {
  primary: "Body", secondary: "Clothes", accent: "Trim", detail: "Details",
};

export const BODY_LABEL: Record<BodyPlan, string> = {
  humanoid: "Humanoid", beast: "Beast", avian: "Avian", serpent: "Serpent", insectoid: "Insect",
  amorphous: "Blob", construct: "Construct", spirit: "Spirit", plant: "Plant", object: "Object",
};

export const GROUP_LABEL: Record<PartGroup, string> = { head: "Head", body: "Body", held: "Held", aura: "Aura" };

export function defaultSpriteForm(): SpriteForm {
  return {
    body: "humanoid", size: "medium", rolls: 0, parts: [],
    palette: { primary: RAMPS.skin[2], secondary: RAMPS.water[1], accent: RAMPS.sand[2], detail: RAMPS.earth[1] },
  };
}

/** Add or remove a part; at most four, and adding a fifth is refused. */
export function togglePart(parts: readonly Part[], part: Part): Part[] {
  if (parts.includes(part)) return parts.filter((p) => p !== part);
  return parts.length >= MAX_BUILDER_PARTS ? [...parts] : [...parts, part];
}

/** True when every control of `form` still shows what `spec` shows. */
function matchesSpec(form: SpriteForm, spec: SpriteSpec): boolean {
  const f = formFromSpec(spec);
  return form.body === f.body && form.size === f.size
    && PALETTE_SLOTS.every((k) => form.palette[k] === f.palette[k])
    && form.parts.length === f.parts.length && form.parts.every((p, i) => p === f.parts[i]);
}

/** A valid `spec` recipe for the form. The glyph follows the name so badges stay readable. */
export function buildSpriteSpec(form: SpriteForm, name = ""): SpriteSpec {
  const letter = /[\p{L}\p{N}]/u.exec(name.trim())?.[0]?.toUpperCase();
  const base = form.base;
  if (base && matchesSpec(form, base)) {
    return SpriteSpecSchema.parse({ ...base, ...(base.glyph || !letter ? {} : { glyph: letter }) });
  }
  const spec: SpriteSpec = {
    kind: "spec", v: 1, body: form.body, size: form.size, traits: base?.traits ?? "",
    palette: { ...form.palette },
    parts: form.parts.slice(0, MAX_BUILDER_PARTS).map((part) => ({ part })),
    ...(base?.pose ? { pose: base.pose } : {}),
    ...(letter ? { glyph: letter } : base?.glyph ? { glyph: base.glyph } : {}),
  };
  return SpriteSpecSchema.parse(spec);
}

/** Read a spec back into the form (for premades and saved characters). Unknown sizes become medium. */
export function formFromSpec(spec: SpriteSpec): SpriteForm {
  return {
    body: spec.body, size: spec.size === "small" ? "small" : "medium", rolls: 0,
    palette: { ...spec.palette }, parts: spec.parts.map((p) => p.part).slice(0, MAX_BUILDER_PARTS),
  };
}

/** A form showing a designed spec (from "Describe your look"), which stays whole until the player tweaks a control. */
export function designedForm(spec: SpriteSpec): SpriteForm {
  return { ...formFromSpec(spec), base: spec };
}

const GROUP_CHANCE: Record<PartGroup, number> = { head: 0.75, body: 0.6, held: 0.7, aura: 0.15 };

/** A look picked deterministically from the name and a counter. */
export function randomLook(name: string, counter: number): SpriteForm {
  const r = rng(hashString(`${name.trim().toLowerCase()}#${counter}`));
  const body = r() < 0.5 ? "humanoid" : BODY_PLANS[rint(r, BODY_PLANS.length)]!;
  const ramps = Object.values(RAMPS);
  const pick = (ramp: readonly string[]) => ramp[rint(r, ramp.length)]!;
  const bodyRamp = body === "humanoid" ? RAMPS.skin : ramps[rint(r, ramps.length)]!;
  const palette: SpritePalette = {
    primary: bodyRamp[1 + rint(r, 3)]!,
    secondary: pick(ramps[rint(r, ramps.length)]!.slice(0, 3)),
    accent: pick(ramps[rint(r, ramps.length)]!.slice(1)),
    detail: pick(ramps[rint(r, ramps.length)]!.slice(0, 3)),
  };
  const parts: Part[] = [];
  for (const g of Object.keys(PART_GROUPS) as PartGroup[]) {
    if (parts.length >= MAX_BUILDER_PARTS || r() > GROUP_CHANCE[g]) continue;
    const list = PART_GROUPS[g];
    parts.push(list[rint(r, list.length)]!);
  }
  if (parts.length === 0) parts.push(PART_GROUPS.held[rint(r, PART_GROUPS.held.length)]!);
  return { body, size: r() < 0.25 ? "small" : "medium", palette, parts, rolls: counter };
}

/** Swatches for the palette picker: every master palette color, ramp by ramp. */
export const SWATCHES: readonly string[] = PALETTE;

// ---------- premades ----------

const spec = (palette: SpritePalette, parts: Part[], glyph: string): SpriteSpec => ({
  kind: "spec", v: 1, body: "humanoid", size: "medium", traits: "", palette, glyph,
  parts: parts.map((part) => ({ part })),
});

/** Looks for the spike party, keyed by fixture character id. */
export const PREMADE_SPECS: Readonly<Record<string, SpriteSpec>> = {
  ch_brindle: spec({ primary: RAMPS.skin[1], secondary: RAMPS.fire[2], accent: RAMPS.sand[2], detail: RAMPS.earth[0] }, ["helmet", "armor", "tool"], "B"),
  ch_tamsin: spec({ primary: RAMPS.skin[3], secondary: RAMPS.water[2], accent: RAMPS.sand[2], detail: RAMPS.stone[0] }, ["hood", "cloak", "sword"], "T"),
  ch_orrin: spec({ primary: RAMPS.skin[1], secondary: RAMPS.grass[1], accent: RAMPS.sand[3], detail: RAMPS.earth[1] }, ["robe", "staff", "leaves"], "O"),
};

/** A spec for any character: the premade look when there is one, else a deterministic look from the name. */
export function lookFor(id: string, name: string): SpriteSpec {
  return PREMADE_SPECS[id] ?? buildSpriteSpec(randomLook(name, 0), name);
}


