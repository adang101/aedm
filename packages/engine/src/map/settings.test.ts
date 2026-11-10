import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, LAYOUTS, MATERIAL_ROLES, MOODS, SETTING_PRESETS, SettingSchema } from "@aedm/schemas";
import type { Setting } from "@aedm/schemas";
import { getMaterial } from "./materials";
import { SETTING_PRESET_DATA, fallbackPreset, inferPreset, resolveSetting } from "./settings";

const setting = (over: Partial<Setting> = {}): Setting => ({ name: "Somewhere", layout: "open_field", environment: "outdoor", mood: "neutral", ...over });

describe("setting presets", () => {
  it("has data for every preset in the schema, with valid defaults", () => {
    expect(Object.keys(SETTING_PRESET_DATA).sort()).toEqual([...SETTING_PRESETS].sort());
    for (const p of SETTING_PRESETS) {
      const d = SETTING_PRESET_DATA[p];
      expect(LAYOUTS).toContain(d.layout);
      expect(ENVIRONMENTS).toContain(d.environment);
      expect(MOODS).toContain(d.mood);
      expect(d.keywords.length).toBeGreaterThan(0);
      for (const v of Object.values(d.density)) expect(v >= 0 && v <= 3 && Number.isInteger(v)).toBe(true);
      for (const role of MATERIAL_ROLES) {
        const ids = d.materials[role] ?? [];
        expect(ids.length, `${p}.${role}`).toBeGreaterThan(0);
        for (const id of ids) expect(getMaterial(id)?.role, `${p}.${role}.${id}`).toBe(role);
      }
    }
  });

  it("covers every layout in at least one preset and falls back for each layout and environment", () => {
    expect(new Set(SETTING_PRESETS.map((p) => SETTING_PRESET_DATA[p].layout))).toEqual(new Set(["rooms_and_corridors", "cave", "open_field", "settlement", "trail", "arena", "islands"]));
    for (const l of LAYOUTS) for (const e of ENVIRONMENTS) expect(SETTING_PRESETS).toContain(fallbackPreset(l, e));
  });
});

describe("inferPreset", () => {
  it("maps names and pitches to presets by keyword", () => {
    expect(inferPreset("glacier rift")).toBe("snowfield");
    expect(inferPreset("sunken cathedral")).toBe("temple");
    expect(inferPreset("smugglers' cove")).toBe("beach");
    expect(inferPreset("airship deck in a storm")).toBe("ship_deck");
    expect(inferPreset("clockwork foundry")).toBe("volcanic");
    expect(inferPreset("The Crypts of Ash")).toBe("crypt");
    expect(inferPreset("a trek across the desert dunes")).toBe("desert");
    // campaign pitches: the old desert / dungeon / forest rules still hold, and plain prose finds nothing
    expect(inferPreset("A caravan crosses the burning dunes toward a lost oasis")).toBe("desert");
    expect(inferPreset("Deep in the dark woods, a grove hides an old secret")).toBe("forest");
    expect(inferPreset("An undead plague spreads from the village")).toBe("town");
    expect(inferPreset("A mystery for the ages. Mine is the quest, yours the glory.")).toBeUndefined();
    expect(inferPreset("qwerty")).toBeUndefined();
    expect(inferPreset("")).toBeUndefined();
  });
});

describe("resolveSetting", () => {
  it("fills every role from the preset, with variants", () => {
    const r = resolveSetting(setting({ preset: "forest" }));
    expect(r.preset).toBe("forest");
    for (const role of MATERIAL_ROLES) {
      expect(r.materials[role].length).toBeGreaterThan(0);
      for (const m of r.materials[role]) expect(m.role).toBe(role);
    }
    expect(r.materials.floor.length).toBeGreaterThanOrEqual(2);
    expect(r.materials.obstacle.map((m) => m.id)).toContain("oak_tree");
    expect(r.density).toEqual(SETTING_PRESET_DATA.forest.density);
    expect(r.decorPool).toBe(r.materials.decor);
    expect(r.materials.liquid.some((m) => !m.walkable)).toBe(true);
  });

  it("lets explicit materials and density override the preset", () => {
    const r = resolveSetting(setting({ preset: "forest", materials: { floor: ["moss"], obstacle: ["boulder", { name: "Gumdrop", role: "obstacle", color: "#ff69b4", tags: [], prompt_traits: "" }] }, density: { obstacles: 0, liquid: 0, hazards: 3 } }));
    expect(r.materials.floor.map((m) => m.id)).toEqual(["moss"]);
    expect(r.materials.obstacle.map((m) => m.id)).toEqual(["boulder", "custom_gumdrop"]);
    expect(r.materials.wall.map((m) => m.id)).toContain("hedge_wall");
    expect(r.density).toEqual({ obstacles: 0, liquid: 0, hazards: 3 });
  });

  it("puts the brief's props first, then the preset's", () => {
    const r = resolveSetting(setting({ preset: "dungeon", materials: { decor: ["cauldron", "anvil"] } }));
    expect(r.decorPool.slice(0, 2).map((m) => m.id)).toEqual(["cauldron", "anvil"]);
    expect(r.decorPool.map((m) => m.id)).toContain("scattered_bones");
  });

  it("infers a preset from the name and tags when none is given, else from layout and environment", () => {
    expect(resolveSetting(setting({ name: "glacier rift" })).preset).toBe("snowfield");
    expect(resolveSetting(setting({ name: "Unnamed", layout: "cave", environment: "underground" }), ["marsh"]).preset).toBe("swamp");
    expect(resolveSetting(setting({ name: "Zzz", layout: "islands", environment: "outdoor" })).preset).toBe("beach");
    expect(resolveSetting(setting({ name: "Zzz", layout: "rooms_and_corridors", environment: "indoor" })).preset).toBe("interior");
  });

  it("makes free-text settings look different from each other", () => {
    const names = ["airship deck in a storm", "glacier rift", "clockwork foundry", "candy forest", "sunken cathedral", "smugglers' cove"];
    const sets = names.map((n) => {
      const r = resolveSetting(setting({ name: n }));
      return MATERIAL_ROLES.flatMap((role) => r.materials[role].map((m) => m.id)).sort().join();
    });
    expect(new Set(sets).size).toBe(names.length);
    const clock = resolveSetting(setting({ name: "clockwork foundry" }));
    expect(clock.materials.obstacle.map((m) => m.id)).toContain("iron_machinery");
    expect(clock.materials.floor[0]!.id).toBe("metal_grate");
    const sky = resolveSetting(setting({ name: "airship deck in a storm", layout: "arena" }));
    expect(sky.preset).toBe("ship_deck");
    expect(sky.materials.liquid.map((m) => m.id)).toContain("cloud_sea");
    expect(sky.materials.hazard.map((m) => m.id)).toContain("storm_arc");
    expect(resolveSetting(setting({ name: "sunken cathedral" })).density.liquid).toBeGreaterThanOrEqual(2);
  });

  it("an explicit preset keeps its own first material when keywords add accents", () => {
    const r = resolveSetting(setting({ name: "clockwork garden", preset: "forest" }));
    expect(r.materials.floor[0]!.id).toBe("forest_grass");
    expect(r.materials.obstacle.map((m) => m.id)).toContain("iron_machinery");
  });

  it("never fails, even for odd input", () => {
    const odd = [
      setting({ name: "💥" }), setting({ name: "x".repeat(40), mood: "eerie", materials: { floor: ["zzz", "frozen_mossy_floor"], decor: ["pipe_organ"] } }),
      setting({ materials: { liquid: [{ name: "Dry", role: "liquid", color: "#ffffff", walkable: true, tags: [], prompt_traits: "" }] } }),
    ];
    for (const s of odd) {
      const r = resolveSetting(SettingSchema.parse(s), ["a", "b"]);
      for (const role of MATERIAL_ROLES) expect(r.materials[role].length).toBeGreaterThan(0);
      expect(r.materials.liquid.some((m) => !m.walkable)).toBe(true);
    }
  });
});
