/**
 * Setting presets (data/settings.json) and `resolveSetting`: turns a brief's open-ended setting into a
 * layout, an environment, a mood and concrete Materials for every role. Never fails.
 */
import { MATERIAL_ROLES, SETTING_PRESETS } from "@aedm/schemas";
import type { Environment, Layout, Material, MaterialRef, MaterialRole, Mood, Setting, SettingPreset } from "@aedm/schemas";
import data from "../../data/settings.json";
import { ensureWallContrast } from "./contrast";
import { defaultForRole, getMaterial, rampPosition, resolveMaterial, shiftColor, words } from "./materials";

export interface Density {
  obstacles: number;
  liquid: number;
  hazards: number;
}

export interface PresetData {
  layout: Layout;
  environment: Environment;
  mood: Mood;
  density: Density;
  /** Library material ids per role, most characteristic first. */
  materials: Partial<Record<MaterialRole, string[]>>;
  keywords: string[];
  starter: { name: string; tags: string[]; pois: string[] };
}

interface Accent {
  keywords: string[];
  materials: Partial<Record<MaterialRole, string[]>>;
  density?: Partial<Density>;
  /** A mood these words imply: a calm brief (bright, neutral, dim) is pushed to it. Dark stays dark. */
  mood?: Mood;
}

interface SettingsFile {
  presets: Record<SettingPreset, PresetData>;
  fallbacks: Record<Layout, Record<Environment, SettingPreset>>;
  accents: Record<string, Accent>;
  mood_decor: Record<Mood, string[]>;
}

const file = data as unknown as SettingsFile;

export const SETTING_PRESET_DATA: Readonly<Record<SettingPreset, PresetData>> = file.presets;
const FALLBACKS = file.fallbacks;
const ACCENTS = Object.values(file.accents);

export interface ResolvedSetting {
  name: string;
  /** The preset whose data filled the gaps: the brief's own, an inferred one, or a layout default. */
  preset: SettingPreset;
  layout: Layout;
  environment: Environment;
  mood: Mood;
  materials: Record<MaterialRole, Material[]>;
  density: Density;
  /** Props scattered as decoration (same as `materials.decor`). */
  decorPool: Material[];
}

// ---------- inference ----------

function keywordMatcher(keywords: readonly string[]): (padded: string) => number {
  const needles = keywords.map((k) => ` ${words(k).join(" ")} `);
  return (padded) => needles.reduce((n, k) => n + (padded.includes(k) ? 1 : 0), 0);
}

const PRESET_MATCHERS = SETTING_PRESETS.map((p) => ({ p, match: keywordMatcher(SETTING_PRESET_DATA[p].keywords) }));
const ACCENT_MATCHERS = ACCENTS.map((a) => ({ a, match: keywordMatcher(a.keywords) }));

const padded = (text: string): string => ` ${words(text).join(" ")} `;

/** The preset whose keywords best match free text (a setting name plus tags, or a campaign pitch), if any. */
export function inferPreset(text: string): SettingPreset | undefined {
  const t = padded(text);
  let best: SettingPreset | undefined;
  let bestScore = 0;
  for (const { p, match } of PRESET_MATCHERS) {
    const score = match(t);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** The preset used when nothing else says what a setting looks like: by layout, then environment. */
export function fallbackPreset(layout: Layout, environment: Environment): SettingPreset {
  return FALLBACKS[layout]?.[environment] ?? "dungeon";
}

// ---------- resolution ----------

const CAPS: Record<MaterialRole, number> = { floor: 3, path: 2, wall: 2, obstacle: 4, liquid: 3, hazard: 3, decor: 10, door: 2 };

function coerce(m: Material, role: MaterialRole): Material {
  // The tile layers decide collision, so a material's flags must agree with the role it is used in.
  const walkable = role === "wall" || role === "obstacle" ? false : role === "liquid" ? m.walkable : true;
  const blocks = role === "wall" ? m.blocks_sight : role === "obstacle" || role === "liquid" ? m.blocks_sight : false;
  return walkable === m.walkable && blocks === m.blocks_sight ? m : { ...m, walkable, blocks_sight: blocks };
}

/** Dark and eerie places read one ramp step darker. Custom (DM-made) materials keep exactly the colors the DM chose. */
const TONE: Record<Mood, number> = { bright: 0, neutral: 0, dim: 0, dark: -1, eerie: -1 };
const TONED_ROLES: ReadonlySet<MaterialRole> = new Set(["floor", "path", "wall", "obstacle", "liquid", "door"]);

function toned(m: Material, role: MaterialRole, tone: number): Material {
  if (tone === 0 || !TONED_ROLES.has(role) || m.id.startsWith("custom_")) return m;
  // ground never goes below the second ramp step, so walls always have somewhere darker to be
  const floorMin = role === "floor" || role === "path" ? 1 : 0;
  const move = (c: string): string => {
    const pos = rampPosition(c);
    return pos ? shiftColor(c, Math.max(tone, floorMin - pos.index)) : c;
  };
  const color = move(m.color);
  const shifted = move(m.accent);
  // keep the original accent where the shift would merge color and accent and erase the pattern
  const accent = color === shifted && m.color !== m.accent ? m.accent : shifted;
  return color === m.color && accent === m.accent ? m : { ...m, color, accent };
}

function dedupe(list: Material[]): Material[] {
  const seen = new Set<string>();
  return list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/**
 * Resolves a setting. The preset (brief's, else inferred from the name and tags, else a layout and environment
 * default) fills every role the brief leaves empty; explicit materials replace a role's preset list. Keyword
 * accents (clockwork, glacier, sunken, ...) add their materials; they lead the lists when the preset was not
 * named. Props from the brief come first, then the preset's.
 */
export function resolveSetting(setting: Setting, themeTags: readonly string[] = []): ResolvedSetting {
  const name = typeof setting.name === "string" ? setting.name : "Unnamed place";
  const text = `${name} ${themeTags.join(" ")}`;
  const explicitPreset = setting.preset && SETTING_PRESET_DATA[setting.preset] ? setting.preset : undefined;
  const preset = explicitPreset ?? inferPreset(text) ?? fallbackPreset(setting.layout, setting.environment);
  const pd = SETTING_PRESET_DATA[preset];
  const t = padded(text);
  const accents = ACCENT_MATCHERS.filter(({ match }) => match(t) > 0).map(({ a }) => a);
  const calm = setting.mood === "bright" || setting.mood === "neutral" || setting.mood === "dim";
  const mood: Mood = calm && accents.some((a) => a.mood === "eerie") ? "eerie" : setting.mood;
  const ctx = { tags: [...themeTags, ...words(name)], mood };

  const idsFor = (role: MaterialRole): string[] => {
    const base = pd.materials[role] ?? [];
    const extra = accents.flatMap((a) => a.materials[role] ?? []);
    if (extra.length === 0) return base;
    return explicitPreset ? [...base.slice(0, 1), ...extra, ...base.slice(1)] : [...extra, ...base];
  };

  const materials = {} as Record<MaterialRole, Material[]>;
  for (const role of MATERIAL_ROLES) {
    const explicit = (setting.materials as Partial<Record<MaterialRole, MaterialRef[]>> | undefined)?.[role];
    const refs: MaterialRef[] = [];
    if (Array.isArray(explicit) && explicit.length > 0) refs.push(...explicit);
    if (role === "decor") {
      refs.push(...idsFor("decor"), ...file.mood_decor[setting.mood]);
    } else if (refs.length === 0) {
      refs.push(...idsFor(role));
    }
    let list = dedupe(refs.map((r) => toned(coerce(resolveMaterial(r, role, ctx), role), role, TONE[mood]))).slice(0, role === "floor" && setting.environment !== "outdoor" ? 2 : CAPS[role]);
    if (list.length === 0) list = [toned(coerce(defaultForRole(role, ctx), role), role, TONE[mood])];
    materials[role] = list;
  }
  if (!materials.liquid.some((m) => !m.walkable)) materials.liquid.push(toned(getMaterial("water") ?? defaultForRole("liquid", ctx), "liquid", TONE[mood]));
  ensureWallContrast(materials);

  const base = setting.density ?? pd.density;
  const density: Density = { obstacles: base.obstacles, liquid: base.liquid, hazards: base.hazards };
  if (!setting.density) {
    for (const a of accents) {
      if (a.density?.liquid !== undefined) density.liquid = Math.max(density.liquid, a.density.liquid);
      if (a.density?.obstacles !== undefined) density.obstacles = Math.max(density.obstacles, a.density.obstacles);
      if (a.density?.hazards !== undefined) density.hazards = Math.max(density.hazards, a.density.hazards);
    }
  }
  return {
    name,
    preset,
    layout: setting.layout,
    environment: setting.environment,
    mood,
    materials,
    density,
    decorPool: materials.decor,
  };
}
