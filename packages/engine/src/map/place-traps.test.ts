import { describe, expect, it } from "vitest";
import { MapSchema, SETTING_PRESETS, type GameMap, type MapObject } from "@aedm/schemas";
import { INTERACT } from "../data.ts";
import { STARTER_BRIEFS, generateMap, getObjects, getSpawn, isWalkable, validateMap } from "./index";

const SEEDS = [11, 4242, 90001, 31337];
type Inter = Extract<MapObject, { type: "interactable" }>;
const traps = (m: GameMap): Inter[] => getObjects(m).filter((o): o is Inter => o.type === "interactable" && o.kind === "trap");
const others = (m: GameMap): MapObject[] => getObjects(m).filter((o) => !(o.type === "interactable" && o.kind === "trap"));
const tileLayer = (m: GameMap, name: string): number[] => {
  const l = m.layers.find((x) => x.type === "tilelayer" && x.name === name);
  return l && l.type === "tilelayer" ? l.data : [];
};
const gen = (preset: (typeof SETTING_PRESETS)[number], seed: number, opts: { trapObjects?: boolean; tier?: number } = {}): GameMap =>
  generateMap(STARTER_BRIEFS[preset], { seed, id: "m_t", ...opts }).map;

/** Flood from the start through passable, non-hazard tiles (4 directions, stricter than the rule). */
function reachableWithoutHazards(map: GameMap): Set<string> {
  const start = getSpawn(map, "party_start")!;
  const roles = new Map(map.tileset.tiles.map((t) => [t.gid, t.role]));
  const ground = tileLayer(map, "ground");
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const queue = [{ x: start.x, y: start.y }];
  for (let q = 0; q < queue.length; q++) {
    const p = queue[q]!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = p.x + dx;
      const y = p.y + dy;
      const k = `${x},${y}`;
      if (seen.has(k) || !isWalkable(map, x, y) || roles.get(ground[y * map.width + x] ?? 0) === "hazard") continue;
      seen.add(k);
      queue.push({ x, y });
    }
  }
  return seen;
}

describe("generated traps", () => {
  it("adds only trap objects: every other object, tile and decor piece of a seed is unchanged", () => {
    let total = 0;
    for (const preset of SETTING_PRESETS) {
      for (const seed of SEEDS) {
        const without = gen(preset, seed, { trapObjects: false });
        const withT = gen(preset, seed);
        total += traps(withT).length;
        expect(traps(without)).toEqual([]);
        expect(others(withT)).toEqual(others(without));
        for (const name of ["ground", "walls", "decor", "above"]) expect(tileLayer(withT, name), `${preset} ${seed} ${name}`).toEqual(tileLayer(without, name));
        expect({ ...withT, layers: [] }).toEqual({ ...without, layers: [] });
        // appended after the rest, never interleaved
        const objs = getObjects(withT);
        expect(objs.slice(0, others(withT).length)).toEqual(others(withT));
      }
    }
    expect(total).toBeGreaterThan(20);
  });
  it("places traps by data: the hazard-density count at most, ids trap_1.., on floor the party can reach, away from everything else", () => {
    for (const preset of SETTING_PRESETS) {
      for (const seed of SEEDS) {
        const map = gen(preset, seed);
        const list = traps(map);
        const start = getSpawn(map, "party_start")!;
        const reach = reachableWithoutHazards(map);
        const roles = new Map(map.tileset.tiles.map((t) => [t.gid, t.role]));
        const ground = tileLayer(map, "ground");
        const occupied = new Map<string, string>();
        for (const o of getObjects(map)) occupied.set(`${o.x},${o.y}`, o.type === "interactable" ? `${o.kind}` : o.type);
        expect(list.map((t) => t.id)).toEqual(list.map((_, i) => `trap_${i + 1}`));
        for (const t of list) {
          const where = `${preset} ${seed} ${t.id}`;
          expect(Math.max(Math.abs(t.x - start.x), Math.abs(t.y - start.y)), where).toBeGreaterThanOrEqual(INTERACT.traps.generated.minSpawnDistance);
          expect(isWalkable(map, t.x, t.y), where).toBe(true);
          expect(reach.has(`${t.x},${t.y}`), where).toBe(true);
          expect(roles.get(ground[t.y * map.width + t.x] ?? 0), where).not.toBe("hazard");
          expect(getObjects(map).filter((o) => o.x === t.x && o.y === t.y).map((o) => o.type), where).toEqual(["interactable"]);
          expect(t.state).toBe("closed");
          expect(t.trap!.dc).toBeGreaterThanOrEqual(5);
          expect(t.trap!.dc).toBeLessThanOrEqual(30);
          expect(INTERACT.traps.damageTypes).toContain(t.trap!.damage_type);
          for (const o of list) if (o !== t) expect(Math.max(Math.abs(o.x - t.x), Math.abs(o.y - t.y)), where).toBeGreaterThanOrEqual(2);
          expect(occupied.get(`${t.x},${t.y}`)).toBe("trap");
        }
        expect(list.length).toBeLessThanOrEqual(Math.max(...Object.values(INTERACT.traps.generated.countByHazardLevel)));
        // the map is still valid, and every exit is still reachable without stepping on a trap-free guarantee
        expect(MapSchema.safeParse(map).success, `${preset} ${seed}`).toBe(true);
        expect(validateMap(map).errors, `${preset} ${seed}`).toEqual([]);
        for (const o of getObjects(map)) if (o.type === "exit") expect(reach.has(`${o.x},${o.y}`), `${preset} ${seed} exit`).toBe(true);
      }
    }
  });
  it("hides hiddenPct of them; some are hidden and some are not across maps", () => {
    const all = SETTING_PRESETS.flatMap((p) => SEEDS.flatMap((s) => traps(gen(p, s))));
    expect(all.some((t) => t.hidden === true)).toBe(true);
    expect(all.some((t) => t.hidden === undefined)).toBe(true);
    expect(all.every((t) => t.hidden === undefined || t.hidden === true)).toBe(true);
  });
  it("DC and dice scale with the loot tier, like locks", () => {
    const seen = new Set<string>();
    for (const tier of [1, 3, 5]) {
      const list = SETTING_PRESETS.flatMap((p) => traps(gen(p, 11, { tier })));
      const base = INTERACT.traps.dcByTier[String(tier)]!;
      expect(list.length).toBeGreaterThan(0);
      for (const t of list) {
        expect(Math.abs(t.trap!.dc - base)).toBeLessThanOrEqual(INTERACT.traps.variance);
        expect(t.trap!.dice).toBe(INTERACT.traps.diceByTier[String(tier)]);
        seen.add(t.trap!.dice);
      }
    }
    expect(seen.size).toBe(3);
  });
  it("is deterministic: the same seed gives the same map", () => {
    expect(JSON.stringify(gen("dungeon", 4242))).toBe(JSON.stringify(gen("dungeon", 4242)));
    expect(JSON.stringify(traps(gen("dungeon", 4242)))).not.toBe(JSON.stringify(traps(gen("dungeon", 4243))));
  });
  it("the data can turn them off, or hide everything", () => {
    const cfg = INTERACT.traps.generated;
    const saved = { enabled: cfg.enabled, hiddenPct: cfg.hiddenPct };
    try {
      cfg.hiddenPct = 100;
      const list = SETTING_PRESETS.flatMap((p) => traps(gen(p, 11)));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((t) => t.hidden === true)).toBe(true);
      cfg.hiddenPct = 0;
      expect(SETTING_PRESETS.flatMap((p) => traps(gen(p, 11))).some((t) => t.hidden)).toBe(false);
      cfg.enabled = false;
      expect(SETTING_PRESETS.flatMap((p) => traps(gen(p, 11)))).toEqual([]);
    } finally {
      cfg.enabled = saved.enabled;
      cfg.hiddenPct = saved.hiddenPct;
    }
  });
});

describe("hidden generated chests (opt-in)", () => {
  it("none are hidden by default; with chest.hiddenPct they are, and nothing else changes", () => {
    const chests = (m: GameMap) => getObjects(m).filter((o): o is Inter => o.type === "interactable" && o.kind === "chest");
    const base = SETTING_PRESETS.flatMap((p) => chests(gen(p, 4242)));
    expect(base.length).toBeGreaterThan(0);
    expect(base.some((c) => c.hidden)).toBe(false);
    const saved = INTERACT.chest.hiddenPct;
    try {
      INTERACT.chest.hiddenPct = 100;
      for (const p of SETTING_PRESETS) {
        const hiddenMap = gen(p, 4242);
        INTERACT.chest.hiddenPct = 0;
        const plain = gen(p, 4242);
        INTERACT.chest.hiddenPct = 100;
        expect(chests(hiddenMap).every((c) => c.hidden === true)).toBe(true);
        expect(traps(hiddenMap)).toEqual(traps(plain));
        expect(getObjects(hiddenMap).map((o) => (o.type === "interactable" ? { ...o, hidden: undefined } : o)).map((o) => JSON.stringify(o)))
          .toEqual(getObjects(plain).map((o) => (o.type === "interactable" ? { ...o, hidden: undefined } : o)).map((o) => JSON.stringify(o)));
        expect(MapSchema.safeParse(hiddenMap).success).toBe(true);
      }
    } finally {
      INTERACT.chest.hiddenPct = saved;
    }
  });
});
