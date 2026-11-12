/** Pure helpers for the Workshop panel, the campaign cast and the per-viewer "hide" preferences (no DOM). */
import {
  type CastEntry, type EntityView, type SaveSprite, type SpriteAssetSource, type SpriteRecipe, type SpriteRoleHint, type WorkshopAsset,
} from "@aedm/schemas";
import { storageGet, storageSet } from "./storage";

export const ROLE_LABEL: Record<SpriteRoleHint, string> = { pc: "Player character", npc: "NPC", enemy: "Enemy", prop: "Prop" };
export const SOURCE_LABEL: Record<SpriteAssetSource, string> = { designed: "Designed", painted_over: "Painted over", painted: "Painted" };
/** Roles the DM can use from the cast. */
export const CAST_ROLES: readonly SpriteRoleHint[] = ["npc", "enemy"];

export function sourceOf(recipe: SpriteRecipe): SpriteAssetSource {
  if (recipe.kind !== "pixel") return "designed";
  return recipe.base ? "painted_over" : "painted";
}

/** The save_sprite_asset payload for a recipe; the source is derived so it always matches the recipe. */
export function savePayload(i: { id?: string | undefined; name: string; role_hint: SpriteRoleHint; concept: string; recipe: SpriteRecipe; tags?: string[] | undefined }): SaveSprite {
  return {
    ...(i.id ? { id: i.id } : {}),
    name: i.name.trim().slice(0, 40) || "Untitled",
    role_hint: i.role_hint,
    concept: i.concept.trim().slice(0, 200),
    tags: (i.tags ?? []).slice(0, 5),
    recipe: i.recipe,
    source: sourceOf(i.recipe),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const canOffer = (a: Pick<WorkshopAsset, "role_hint">): boolean => CAST_ROLES.includes(a.role_hint);

/** Workshop assets of the viewer that can still be offered (npc or enemy, not already in the cast). */
export function offerable(assets: readonly WorkshopAsset[], cast: readonly CastEntry[]): WorkshopAsset[] {
  const inCast = new Set(cast.map((c) => c.asset_id));
  return assets.filter((a) => canOffer(a) && !inCast.has(a.id));
}

// ---------- per-viewer hide preferences (localStorage, never required) ----------

const HIDDEN_KEY = "aedm.hidden_cast";
const PAINTINGS_KEY = "aedm.hide_paintings";

export interface HidePrefs { ids: Set<string>; paintings: boolean }

let prefs: HidePrefs | null = null;

export function hidePrefs(): HidePrefs {
  if (prefs) return prefs;
  const ids = new Set<string>();
  const raw = storageGet(HIDDEN_KEY);
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v)) for (const x of v.slice(0, 200)) if (typeof x === "string" && x.length <= 64) ids.add(x);
    } catch { /* unreadable: start empty */ }
  }
  prefs = { ids, paintings: storageGet(PAINTINGS_KEY) === "1" };
  return prefs;
}

export function setEntryHidden(assetId: string, hidden: boolean): void {
  const p = hidePrefs();
  if (hidden) p.ids.add(assetId); else p.ids.delete(assetId);
  storageSet(HIDDEN_KEY, JSON.stringify([...p.ids]));
}

export function setHidePaintings(on: boolean): void {
  hidePrefs().paintings = on;
  storageSet(PAINTINGS_KEY, on ? "1" : "0");
}

/** Tests: forget the in-memory copy so the next read goes to storage again. */
export function resetHidePrefs(): void { prefs = null; }

/** What a hidden custom sprite looks like to the viewer who hid it. */
export const MASK_SPRITE: SpriteRecipe = { kind: "shape", shape: "circle", color: "#6b6b7b", accent: "#9a9aab", glyph: "?" };

const keys = new WeakMap<object, string>();
/** A cheap identity for a recipe: painted ones by their pixels, the rest by their JSON. */
export function recipeKey(r: SpriteRecipe): string {
  const hit = keys.get(r);
  if (hit !== undefined) return hit;
  const k = r.kind === "pixel" ? `px:${r.palette.join("")}:${r.pixels}` : JSON.stringify(r);
  keys.set(r, k);
  return k;
}

/** The sprite to show: the recipe itself, or the mask (or a painting's base spec) when the viewer chose to hide it. */
export function shownRecipe(recipe: SpriteRecipe, cast: readonly CastEntry[], p: HidePrefs = hidePrefs()): SpriteRecipe {
  if (p.ids.size === 0 && !p.paintings) return recipe;
  const hiddenEntry = p.ids.size > 0 && cast.some((c) => p.ids.has(c.asset_id) && recipeKey(c.recipe) === recipeKey(recipe));
  if (hiddenEntry) return MASK_SPRITE;
  if (p.paintings && recipe.kind === "pixel") return recipe.base ?? MASK_SPRITE;
  return recipe;
}

export function shownEntity(e: EntityView, cast: readonly CastEntry[], p: HidePrefs = hidePrefs()): EntityView {
  const sprite = shownRecipe(e.sprite, cast, p);
  return sprite === e.sprite ? e : { ...e, sprite };
}
