/**
 * Map QA gallery (?mock=1&gallery=maps): engine-generated maps for every setting preset, every layout and a few
 * free-text settings, each as a downscaled full-map thumbnail plus one 1:1 crop. Optional `&seed=N`. Not used by the game.
 */
import { SETTING_PRESETS, type GameMap, type Layout, type MapBrief } from "@aedm/schemas";
import { STARTER_BRIEFS, generateMap, getSpawn } from "@aedm/engine";
import { h } from "../util/dom";
import { TILE } from "./camera";
import { drawLights, drawMood, type Light } from "./mood";
import { extractLayers, paintMapLayers } from "./renderer";
import { makeCanvas } from "./px";

const THUMB_W = 520;
const CROP_W = 14, CROP_H = 9;

type Entry = { label: string; brief: MapBrief };

const rooms = (type: "chamber" | "outdoor" | "cave" | "hall"): MapBrief["rooms"] => [
  { id: "r1", type, size: "medium", connects_to: ["r2"] },
  { id: "r2", type: type === "chamber" ? "hall" : type, size: "small", connects_to: ["r1"] },
];

/** The brief the fake DM builds for a travel intent, so free-text maps look the way they do in play. */
function freeText(name: string, layout: Layout, environment: MapBrief["setting"]["environment"], mood: MapBrief["setting"]["mood"], materials?: MapBrief["setting"]["materials"], preset?: MapBrief["setting"]["preset"]): MapBrief {
  return {
    setting: { name, ...(preset ? { preset } : {}), layout, environment, mood, ...(materials ? { materials } : {}) },
    theme_tags: ["interior", "quiet"], size_class: "small",
    rooms: rooms(environment === "outdoor" ? "outdoor" : layout === "cave" ? "cave" : "chamber"),
    points_of_interest: [{ kind: "altar", room_id: "r2" }], entity_slots: [{ role: "npc", room_id: "r1", count: 1 }],
    exits: [{ side: "south", label: "The way you came" }],
  };
}

function presetEntries(): Entry[] {
  return SETTING_PRESETS.map((p) => ({ label: `preset: ${p}`, brief: STARTER_BRIEFS[p] }));
}

function layoutEntries(): Entry[] {
  const byLayout: Record<string, Entry> = {};
  for (const p of SETTING_PRESETS) {
    const b = STARTER_BRIEFS[p];
    byLayout[b.setting.layout] ??= { label: `layout: ${b.setting.layout} (${p})`, brief: b };
  }
  const extra: Entry[] = [
    { label: "layout: maze (hedge maze)", brief: freeText("Hedge maze", "maze", "outdoor", "eerie") },
    { label: "layout: maze (stone labyrinth)", brief: freeText("Stone labyrinth", "maze", "underground", "dark") },
    { label: "layout: islands (shoals)", brief: freeText("Scattered isles", "islands", "outdoor", "bright") },
  ];
  return [...Object.values(byLayout), ...extra];
}

function freeEntries(): Entry[] {
  return [
    { label: "free: sunken cathedral (as the fake DM briefs it)", brief: freeText("Sunken cathedral", "rooms_and_corridors", "indoor", "eerie", undefined, "temple") },
    { label: "free: sunken cathedral, calm brief mood (dim)", brief: freeText("Sunken cathedral", "rooms_and_corridors", "indoor", "dim", undefined, "temple") },
    { label: "free: glacier rift", brief: freeText("Glacier rift", "open_field", "outdoor", "bright", undefined, "snowfield") },
    { label: "free: clockwork foundry", brief: freeText("Clockwork foundry", "rooms_and_corridors", "indoor", "dim") },
    { label: "free: smugglers' cove", brief: freeText("Smugglers' cove", "open_field", "outdoor", "bright", undefined, "beach") },
    {
      label: "free: candy forest (custom materials)",
      brief: freeText("Candy forest", "trail", "outdoor", "bright", {
        floor: [{ name: "Pink icing", role: "floor", color: "#d39a72", accent: "#f2cfa6", pattern: "speckle", tags: ["sweet"], prompt_traits: "pink icing" }],
        wall: [{ name: "Gumdrop hedge", role: "wall", color: "#d39a72", accent: "#c0392b", pattern: "dots", tags: ["sweet"], prompt_traits: "gumdrop hedge" }],
        obstacle: [{ name: "Lollipop tree", role: "obstacle", color: "#c0392b", accent: "#f6e8a0", pattern: "rings", tags: ["tree"], prompt_traits: "lollipop tree" }],
      }),
    },
  ];
}

/** Paints a whole map (no entities) at 1:1 onto a canvas, including mood tint and lights. */
function paintFull(map: GameMap): HTMLCanvasElement {
  const L = extractLayers(map);
  const c = makeCanvas(map.width * TILE, map.height * TILE);
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  const lights: Light[] = [];
  paintMapLayers(g, L, { x0: 0, y0: 0, x1: map.width - 1, y1: map.height - 1 }, 0, { lights });
  drawMood(g, L.mood, c.width, c.height, 0);
  drawLights(g, L.mood, lights, 1, 0, 0, 0);
  return c;
}

function card(e: Entry, seed: number, id: number): HTMLElement {
  let map: GameMap;
  try {
    map = generateMap(e.brief, { seed: seed + id * 17, id: `m_gal_${id}` }).map;
  } catch (err) {
    return h("div", { class: "mapcard" }, h("b", null, e.label), h("span", { class: "muted" }, `failed: ${String(err)}`));
  }
  const full = paintFull(map);
  const thumb = h("canvas", { width: THUMB_W, height: Math.round((THUMB_W * full.height) / full.width), class: "map-thumb" });
  const tg = thumb.getContext("2d")!;
  tg.imageSmoothingEnabled = true;
  tg.imageSmoothingQuality = "high";
  tg.drawImage(full, 0, 0, thumb.width, thumb.height);
  // the 1:1 crop is centred on the party start
  const s = getSpawn(map, "party_start") ?? { x: map.width >> 1, y: map.height >> 1 };
  const cx = Math.max(0, Math.min(map.width - CROP_W, s.x - (CROP_W >> 1)));
  const cy = Math.max(0, Math.min(map.height - CROP_H, s.y - (CROP_H >> 1)));
  const crop = h("canvas", { width: CROP_W * TILE, height: CROP_H * TILE, class: "map-crop" });
  const cg = crop.getContext("2d")!;
  cg.imageSmoothingEnabled = false;
  cg.drawImage(full, cx * TILE, cy * TILE, CROP_W * TILE, CROP_H * TILE, 0, 0, crop.width, crop.height);
  const st = map.meta.setting;
  return h("div", { class: "mapcard" },
    h("div", { class: "mapcard-head" }, h("b", null, e.label), h("span", { class: "muted" }, ` ${map.width}x${map.height}, ${st.layout}, ${st.environment}, mood ${st.mood}, ${map.tileset.tiles.length} tiles`)),
    h("div", { class: "mapcard-row" }, thumb, crop));
}

export function mountMapGallery(root: HTMLElement): void {
  document.body.style.overflow = "auto";
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get("seed") ?? 1234) || 1234;
  let id = 0;
  const section = (title: string, list: Entry[]) =>
    h("section", { class: "mapsection", id: title.split(" ")[0]!.toLowerCase() }, h("h2", null, title), ...list.map((e) => card(e, seed, id++)));
  const page = h("div", { class: "gallery-page maps" },
    h("h1", null, "Map gallery"),
    h("p", { class: "muted" }, `Engine-generated maps, seed ${seed}. Left: whole map downscaled. Right: 1:1 crop at the party start.`),
    section("Presets", presetEntries()), section("Layouts", layoutEntries()), section("Free-text settings", freeEntries()));
  root.replaceChildren(page);
  (window as unknown as { __galleryReady: boolean }).__galleryReady = true;
}
