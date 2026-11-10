/**
 * The material library and the resolver. A brief names materials by library id, by a looser name, or by an
 * inline draft; `resolveMaterial` always returns a valid, palette-snapped Material and never throws.
 */
import { MaterialDraftSchema, MaterialSchema, PALETTE, PATTERNS, RAMP_NAMES, isHex, materialDefaults, snapToPalette } from "@aedm/schemas";
import type { Material, MaterialDraft, MaterialRole, Mood, Pattern } from "@aedm/schemas";
import data from "../../data/materials.json";

export interface MaterialContext {
  /** Theme tags and setting words: used to break ties and pick role defaults. */
  tags: readonly string[];
  mood: Mood;
}

interface MaterialsFile {
  materials: Material[];
  aliases: Record<string, string[]>;
}

const file = data as unknown as MaterialsFile;

export const MATERIALS: readonly Material[] = Object.freeze(file.materials.map((m) => Object.freeze(m)));
export const MATERIAL_IDS: readonly string[] = Object.freeze(MATERIALS.map((m) => m.id));

const BY_ID = new Map<string, Material>(MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: string): Material | undefined {
  return BY_ID.get(id);
}

// ---------- text helpers ----------

/** Lowercase words, singularised crudely, so "Oak Trees" and "oak_tree" compare equal. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(singular);
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

const norm = (s: string): string => words(s).join(" ");

/** Words that describe a thing without naming it, ignored when matching a free-text prop name. */
const FILLER = new Set([
  "the", "a", "an", "of", "and", "old", "ancient", "broken", "small", "large", "big", "giant", "huge", "tiny", "dark", "rusty", "rusted",
  "weathered", "carved", "grand", "great", "little", "worn", "crumbling", "ruined", "strange", "odd", "mysterious", "glowing", "silent", "lost",
]);

// ---------- indexes ----------

const ROLE_LIST: Record<MaterialRole, Material[]> = {
  floor: [], path: [], wall: [], obstacle: [], liquid: [], hazard: [], decor: [], door: [],
};
for (const m of MATERIALS) ROLE_LIST[m.role].push(m);

interface Indexed {
  m: Material;
  name: string;
  nameWords: Set<string>;
  idWords: Set<string>;
  tagWords: Set<string>;
  traitWords: Set<string>;
}
const INDEX: Record<MaterialRole, Indexed[]> = {
  floor: [], path: [], wall: [], obstacle: [], liquid: [], hazard: [], decor: [], door: [],
};
for (const m of MATERIALS) {
  INDEX[m.role].push({
    m,
    name: norm(m.name),
    nameWords: new Set(words(m.name)),
    idWords: new Set(words(m.id)),
    tagWords: new Set(m.tags.flatMap(words)),
    traitWords: new Set(words(m.prompt_traits)),
  });
}

const ALIASES = new Map<string, string[]>(Object.entries(file.aliases).map(([k, v]) => [norm(k), v]));

// ---------- finding a library material ----------

function byAlias(q: string, role: MaterialRole): Material | undefined {
  for (const id of ALIASES.get(q) ?? []) {
    const m = BY_ID.get(id);
    if (m && m.role === role) return m;
  }
  return undefined;
}

/**
 * Looks a reference up in the library for a role: exact id, then normalized name or alias, then word overlap
 * with names (and, unless `strict`, tags and traits). Returns undefined when nothing fits.
 */
export function findMaterial(ref: string, role: MaterialRole, ctx: MaterialContext, strict = false): Material | undefined {
  const exact = BY_ID.get(ref.trim().toLowerCase());
  if (exact && exact.role === role) return exact;

  const q = norm(ref);
  if (q === "") return undefined;
  const list = INDEX[role];
  for (const e of list) if (e.name === q || [...e.idWords].join(" ") === q) return e.m;
  const alias = byAlias(q, role);
  if (alias) return alias;

  const qw = words(ref);
  const content = qw.filter((w) => !FILLER.has(w));
  if (content.length === 0) return undefined;
  // single-word aliases: any content word that is an alias for this role
  for (const w of content) {
    const a = byAlias(w, role);
    if (a) return a;
  }
  const ctxTags = new Set(ctx.tags.flatMap(words));
  let best: Material | undefined;
  let bestScore = 0;
  for (const e of list) {
    let score = 0;
    for (const w of content) {
      if (e.nameWords.has(w) || e.idWords.has(w)) score += 3;
      else if (!strict) {
        if (e.tagWords.has(w)) score += 2;
        else if (e.traitWords.has(w)) score += 1;
      }
    }
    if (score === 0) continue;
    for (const t of e.tagWords) if (ctxTags.has(t)) score += 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = e.m;
    }
  }
  return best;
}

/** The library's best default for a role, nudged toward the context's tags and mood. Deterministic. */
export function defaultForRole(role: MaterialRole, ctx: MaterialContext): Material {
  const ctxTags = new Set(ctx.tags.flatMap(words));
  if (ctx.mood === "dark" || ctx.mood === "eerie" || ctx.mood === "dim") ctxTags.add("dark");
  if (ctx.mood === "bright") ctxTags.add("bright");
  let best = ROLE_LIST[role][0]!;
  let bestScore = -1;
  for (const e of INDEX[role]) {
    let score = 0;
    for (const t of e.tagWords) if (ctxTags.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = e.m;
    }
  }
  return best;
}

// ---------- drafts ----------

const PATTERN_WORDS: ReadonlyArray<readonly [Pattern, readonly string[]]> = [
  ["bricks", ["brick"]],
  ["planks", ["plank", "board", "wood", "timber", "deck", "log"]],
  ["cobbles", ["cobble", "pebble", "flagstone", "paving", "stone"]],
  ["tiles", ["tile", "mosaic", "checker", "slab", "marble", "ceramic"]],
  ["waves", ["wave", "wavy", "ripple", "rippling", "water", "swell", "tide", "liquid", "flow"]],
  ["cracks", ["crack", "fissure", "fracture", "split", "craze"]],
  ["grain", ["grain", "veined", "vein"]],
  ["grass", ["grass", "blade", "moss", "fur", "fern", "leaf", "leaves", "hedge", "meadow", "lawn", "frond"]],
  ["sand", ["sand", "dune", "dust", "silt"]],
  ["speckle", ["speckle", "fleck", "spot", "grit", "gravel", "freckle", "sprinkle", "candy", "sprinkles"]],
  ["rings", ["ring", "circle", "concentric", "spiral", "swirl", "round"]],
  ["scales", ["scale", "shingle", "feather"]],
  ["runes", ["rune", "glyph", "sigil", "arcane", "script", "symbol"]],
  ["glow", ["glow", "shine", "light", "radiant", "luminous", "gleam", "sparkle", "glitter", "neon", "shimmer"]],
  ["lattice", ["lattice", "grid", "mesh", "net", "weave", "woven", "trellis", "cage", "grate", "wire"]],
  ["stripes", ["stripe", "line", "band", "bar", "striped", "ribbed"]],
  ["cross", ["cross", "plus", "hatch"]],
  ["dots", ["dot", "polka", "bead", "bubble", "stud", "pock"]],
];

/** Closest allowed pattern for a free word or phrase, else "none". */
export function closestPattern(p: string | undefined): Pattern {
  if (!p) return "none";
  const t = p.trim().toLowerCase();
  if ((PATTERNS as readonly string[]).includes(t)) return t as Pattern;
  const ws = words(t);
  for (const [pattern, keys] of PATTERN_WORDS) {
    if (ws.some((w) => keys.includes(w)) || keys.some((k) => t.includes(k))) return pattern;
  }
  return "none";
}

/** Position of a palette color in its ramp, or undefined for the outline color. */
export function rampPosition(hex: string): { ramp: (typeof RAMP_NAMES)[number]; index: number } | undefined {
  const h = hex.toLowerCase();
  for (const ramp of RAMP_NAMES) {
    const index = PALETTE[ramp].indexOf(h);
    if (index >= 0) return { ramp, index };
  }
  return undefined;
}

/** Moves a palette color along its ramp by whole steps, clamped; colors off the ramps are unchanged. */
export function shiftColor(hex: string, steps: number): string {
  const pos = rampPosition(hex);
  if (!pos) return hex;
  return PALETTE[pos.ramp][Math.max(0, Math.min(3, pos.index + steps))]!;
}

/** A companion color from the same ramp: one step lighter (or darker at the top). */
export function deriveAccent(color: string): string {
  const pos = rampPosition(color);
  if (!pos) return PALETTE.stone[0];
  return PALETTE[pos.ramp][pos.index === 3 ? 2 : pos.index + 1]!;
}

export function slug(name: string, max: number): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (s === "" ? "material" : s).slice(0, max).replace(/_+$/, "") || "material";
}

/** Deterministic id for an inline material: `custom_` plus a slug of its name (32 characters at most). */
export function customId(name: string): string {
  return `custom_${slug(name, 32 - "custom_".length)}`;
}

const cleanTags = (tags: readonly string[] | undefined): string[] =>
  [...new Set((tags ?? []).map((t) => String(t).trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 6);

function fromDraft(raw: unknown, role: MaterialRole, ctx: MaterialContext): Material {
  const fallback = defaultForRole(role, ctx);
  const parsed = MaterialDraftSchema.safeParse(raw);
  // A draft that fails the schema is repaired field by field rather than thrown away.
  const d: Partial<MaterialDraft> = parsed.success ? parsed.data : (raw as Partial<MaterialDraft>);
  const name = (typeof d.name === "string" && d.name.trim() !== "" ? d.name.trim() : "Custom material").slice(0, 40).trim();
  const color = isHex(d.color) ? snapToPalette(d.color) : fallback.color;
  const accent = isHex(d.accent) ? snapToPalette(d.accent) : deriveAccent(color);
  const patternWord = typeof d.pattern === "string" ? d.pattern : undefined;
  const pattern = patternWord ? closestPattern(patternWord) : closestPattern(name);
  const defaults = materialDefaults({ role, walkable: typeof d.walkable === "boolean" ? d.walkable : undefined, blocks_sight: typeof d.blocks_sight === "boolean" ? d.blocks_sight : undefined });
  const m: Material = {
    id: customId(name),
    name,
    role,
    color,
    accent,
    pattern,
    walkable: defaults.walkable,
    blocks_sight: defaults.blocks_sight,
    tags: cleanTags(d.tags),
    prompt_traits: (typeof d.prompt_traits === "string" ? d.prompt_traits.trim() : "").slice(0, 120).trim(),
  };
  if (role === "hazard") m.hazard = d.hazard && MaterialSchema.shape.hazard.safeParse(d.hazard).success ? d.hazard : { damage_type: "sharp", dice: "1d4" };
  return MaterialSchema.safeParse(m).success ? m : fallback;
}

/**
 * Resolves a brief's material reference to a Material for a role. Order: exact id, normalized name or alias,
 * tag and word overlap within the role, then the role's best default. A draft is validated, its colors snapped
 * to the palette, an unknown pattern mapped to the closest allowed one (else "none"), walkable and blocks_sight
 * defaulted by role, and its id derived from the name (`custom_` plus a slug). Never throws.
 */
export function resolveMaterial(ref: string | MaterialDraft, role: MaterialRole, ctx: MaterialContext): Material {
  try {
    if (typeof ref === "string") return findMaterial(ref, role, ctx) ?? defaultForRole(role, ctx);
    if (ref !== null && typeof ref === "object") return fromDraft(ref, role, ctx);
  } catch {
    // fall through to the default
  }
  return defaultForRole(role, ctx);
}
