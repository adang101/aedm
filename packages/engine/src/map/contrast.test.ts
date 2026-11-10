import { describe, expect, it } from "vitest";
import { MOODS, SETTING_PRESETS, SettingSchema } from "@aedm/schemas";
import type { GameMap, MaterialRole, Setting } from "@aedm/schemas";
import { MIN_WALL_CONTRAST, lum, wallFloorContrast } from "./contrast";
import { generateMap } from "./generator";
import { STARTER_BRIEFS } from "./briefs";
import { MATERIAL_IDS, getMaterial } from "./materials";
import { MapRng } from "./prng";
import { SETTING_PRESET_DATA, resolveSetting } from "./settings";

const setting = (over: Partial<Setting> = {}): Setting => ({ name: "Somewhere", layout: "rooms_and_corridors", environment: "indoor", mood: "neutral", ...over });

/** Smallest luminance gap between any wall tile and any floor or path tile in a generated tileset (base variants). */
function mapContrast(map: GameMap): number {
  const tiles = map.tileset.tiles;
  const walls = tiles.filter((t) => t.role === "wall" && t.variant === 0);
  const floors = tiles.filter((t) => (t.role === "floor" || t.role === "path") && t.variant === 0);
  let min = Infinity;
  for (const w of walls) for (const f of floors) min = Math.min(min, Math.abs(lum(w.color) - lum(f.color)));
  return min;
}

describe("wall and floor contrast", () => {
  it("every preset keeps walls apart from floors and paths, in every mood", () => {
    for (const p of SETTING_PRESETS) {
      const d = SETTING_PRESET_DATA[p];
      for (const mood of MOODS) {
        const r = resolveSetting(setting({ preset: p, layout: d.layout, environment: d.environment, mood }));
        expect(wallFloorContrast(r.materials), `${p}/${mood}`).toBeGreaterThanOrEqual(MIN_WALL_CONTRAST);
      }
    }
  });

  it("holds in the generated tileset for every starter brief", () => {
    for (const p of SETTING_PRESETS) {
      const { map } = generateMap(STARTER_BRIEFS[p], { seed: 5, id: "m_c" });
      expect(mapContrast(map), p).toBeGreaterThanOrEqual(MIN_WALL_CONTRAST - 1e-9);
    }
  });

  it("holds for free-text settings with custom materials", () => {
    const names = ["sunken cathedral", "glacier rift", "clockwork foundry", "smugglers' cove", "candy forest"];
    for (const name of names) {
      const s = setting({
        name, mood: "eerie",
        ...(name === "candy forest"
          ? { materials: { floor: [{ name: "Pink icing", role: "floor", color: "#d39a72", pattern: "speckle", tags: [], prompt_traits: "" }], wall: [{ name: "Gumdrop wall", role: "wall", color: "#d39a72", tags: [], prompt_traits: "" }] } }
          : {}),
      });
      const r = resolveSetting(SettingSchema.parse(s));
      expect(wallFloorContrast(r.materials), name).toBeGreaterThanOrEqual(MIN_WALL_CONTRAST);
    }
  });

  it("holds for a fuzz of random library and custom materials", () => {
    const rng = new MapRng(99);
    const colors = ["#2f5d34", "#7cb342", "#3b3f55", "#c4c9dc", "#f6e8a0", "#1f3f7a", "#9b72d8", "#70472f", "#c0392b", "#a5654a"];
    const lib = (role: MaterialRole) => MATERIAL_IDS.filter((id) => getMaterial(id)!.role === role);
    for (let i = 0; i < 300; i++) {
      const mood = rng.pick([...MOODS]);
      const pick = (role: MaterialRole, n: number) =>
        Array.from({ length: n }, () => (rng.chance(0.4)
          ? { name: `Custom ${role} ${rng.int(0, 99)}`, role, color: rng.pick(colors), accent: rng.pick(colors), tags: [], prompt_traits: "" }
          : rng.pick(lib(role))));
      const s = SettingSchema.parse(setting({
        mood,
        materials: { floor: pick("floor", rng.int(1, 3)), path: pick("path", rng.int(1, 2)), wall: pick("wall", rng.int(1, 2)) } as never,
      }));
      const r = resolveSetting(s);
      expect(wallFloorContrast(r.materials), JSON.stringify(s.materials)).toBeGreaterThanOrEqual(MIN_WALL_CONTRAST);
    }
  });

  it("keeps walls dark enough to read as solid in dark and eerie moods", () => {
    for (const mood of ["dark", "eerie"] as const) {
      const r = resolveSetting(setting({ preset: "temple", mood }));
      for (const w of r.materials.wall) expect(lum(w.color)).toBeLessThan(0.45);
    }
  });
});

describe("mood from the words of a setting", () => {
  it("eerie words push a calm mood to eerie, and leave dark alone", () => {
    for (const name of ["sunken cathedral", "haunted manor", "Drowned Crypt", "cursed chapel"]) {
      for (const mood of ["bright", "neutral", "dim"] as const) expect(resolveSetting(setting({ name, mood })).mood, `${name}/${mood}`).toBe("eerie");
    }
    expect(resolveSetting(setting({ name: "sunken cathedral", mood: "dark" })).mood).toBe("dark");
    expect(resolveSetting(setting({ name: "sunny meadow", mood: "bright" })).mood).toBe("bright");
  });

  it("a sunken cathedral gets temple stone, water and an eerie mood on the generated map", () => {
    const { map } = generateMap(
      { ...STARTER_BRIEFS.temple, setting: { name: "Sunken Cathedral", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" }, theme_tags: ["interior"] },
      { seed: 3, id: "m_s" },
    );
    expect(map.meta.setting.mood).toBe("eerie");
    expect(map.tileset.tiles.some((t) => t.role === "liquid")).toBe(true);
  });
});
