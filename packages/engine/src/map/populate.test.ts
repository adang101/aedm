import { describe, expect, it } from "vitest";
import { MapSchema, SETTING_PRESETS, SIGN_TEXT_MAX } from "@aedm/schemas";
import type { GameMap, MapBrief, MapObject } from "@aedm/schemas";
import { INTERACT } from "../data.ts";
import { addMap } from "../map-state.ts";
import { createGameState } from "../state.ts";
import { BIBLE, FACTS } from "../testkit.ts";
import { STARTER_BRIEFS, generateMap, getObjects, validateMap } from "./index";

type Interactable = Extract<MapObject, { type: "interactable" }>;
const interactables = (m: GameMap): Interactable[] => getObjects(m).filter((o): o is Interactable => o.type === "interactable");
const SEEDS = [11, 4242, 90001, 31337];

/** A rooms-and-corridors brief with one of everything the engine now fills in. */
const brief = (over: Partial<MapBrief> = {}): MapBrief => ({
  ...STARTER_BRIEFS.dungeon,
  points_of_interest: [
    { kind: "chest", room_id: "vault" }, { kind: "chest", room_id: "main" }, { kind: "lever", room_id: "hall" },
    { kind: "signpost", room_id: "hall" }, { kind: "signpost", room_id: "entry" }, { kind: "door", room_id: "main" }, { kind: "altar", room_id: "side" },
  ],
  ...over,
});

describe("generated door objects", () => {
  it("are on by default (`interact.doors.generated.enabled`), and doorObjects: false leaves maps as they were", () => {
    expect(INTERACT.doors.generated.enabled).toBe(true);
    const off = generateMap(brief(), { seed: 3, id: "m_a", doorObjects: false }).map;
    expect(interactables(off).filter((o) => o.id.startsWith("door_")).length).toBeLessThanOrEqual(1); // at most the one POI door
    const on = generateMap(brief(), { seed: 3, id: "m_a" }).map;
    expect(interactables(on).filter((o) => o.kind === "door").length).toBeGreaterThan(interactables(off).filter((o) => o.kind === "door").length);
  });

  it("turn every door tile into a door object when enabled, without touching the tiles", () => {
    for (const seed of SEEDS) {
      const off = generateMap(brief(), { seed, id: "m_a", doorObjects: false }).map;
      const on = generateMap(brief(), { seed, id: "m_a", doorObjects: true }).map;
      expect(on.layers.filter((l) => l.type === "tilelayer")).toEqual(off.layers.filter((l) => l.type === "tilelayer"));
      const defs = new Map(on.tileset.tiles.map((t) => [t.gid, t]));
      const ground = on.layers.find((l) => l.type === "tilelayer" && l.name === "ground");
      const doorTiles = new Set<string>();
      if (ground && ground.type === "tilelayer") ground.data.forEach((g, i) => { if (defs.get(g)?.role === "door") doorTiles.add(`${i % on.width},${Math.floor(i / on.width)}`); });
      const doorObjs = interactables(on).filter((o) => o.kind === "door");
      const covered = new Set(doorObjs.map((o) => `${o.x},${o.y}`));
      for (const t of doorTiles) expect(covered.has(t), `seed ${seed}: door tile ${t}`).toBe(true);
      expect(doorObjs.length).toBeGreaterThan(0);
      expect(new Set(doorObjs.map((o) => o.id)).size).toBe(doorObjs.length);
    }
  });

  it("start open, closed or locked by the data's odds; locked ones carry a lock", () => {
    const states = new Map<string, number>();
    for (let seed = 1; seed <= 60; seed++) {
      for (const o of interactables(generateMap(brief(), { seed, id: "m_a", doorObjects: true }).map)) {
        if (o.kind !== "door") continue;
        states.set(o.state, (states.get(o.state) ?? 0) + 1);
        if (o.state === "locked") expect(o.lock?.dc).toBeGreaterThanOrEqual(5);
      }
    }
    expect(states.get("open")).toBeGreaterThan(0);
    expect(states.get("closed")).toBeGreaterThan(0);
    expect(states.get("locked")).toBeGreaterThan(0);
  });

  it("every map still validates and parses, every starter brief included (locked doors count as passable)", () => {
    for (const preset of SETTING_PRESETS) {
      const { map } = generateMap(STARTER_BRIEFS[preset], { seed: 21, id: "m_s", doorObjects: true, tier: 3 });
      expect(validateMap(map).errors, preset).toEqual([]);
      expect(MapSchema.safeParse(map).success, preset).toBe(true);
    }
    for (const seed of SEEDS) {
      const { map } = generateMap(brief(), { seed, id: "m_a", doorObjects: true, tier: 5 });
      expect(validateMap(map).errors).toEqual([]);
      expect(MapSchema.safeParse(map).success).toBe(true);
    }
  });
});

describe("locks by tier", () => {
  const dcs = (tier: number): number[] => {
    const out: number[] = [];
    for (let seed = 1; seed <= 80; seed++) {
      for (const o of interactables(generateMap(brief(), { seed, id: "m_a", doorObjects: true, tier }).map)) if (o.lock) out.push(o.lock.dc);
    }
    return out;
  };
  it("every locked chest and door has a lock inside its tier's band", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      const base = INTERACT.locks.dcByTier[String(tier)]!;
      const list = dcs(tier);
      expect(list.length).toBeGreaterThan(0);
      for (const dc of list) {
        expect(dc).toBeGreaterThanOrEqual(Math.max(5, base - INTERACT.locks.variance));
        expect(dc).toBeLessThanOrEqual(Math.min(30, base + INTERACT.locks.variance));
      }
    }
  });
  it("higher tiers are harder", () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(dcs(5))).toBeGreaterThan(avg(dcs(3)));
    expect(avg(dcs(3))).toBeGreaterThan(avg(dcs(1)));
  });
  it("a locked chest or door from a point of interest always has one, and an unlocked one never does", () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const o of interactables(generateMap(brief(), { seed, id: "m_a" }).map)) {
        if (o.kind !== "chest" && o.kind !== "door") continue;
        expect(!!o.lock, `seed ${seed} ${o.id} ${o.state}`).toBe(o.state === "locked");
      }
    }
  });
});

describe("signs and levers", () => {
  it("every sign carries text of at most 200 characters from the templates, deterministic for a seed", () => {
    const lines = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const a = generateMap(brief(), { seed, id: "m_a" }).map;
      const b = generateMap(brief(), { seed, id: "m_a" }).map;
      expect(a).toEqual(b);
      const signs = interactables(a).filter((o) => o.kind === "sign");
      expect(signs.length).toBe(2);
      for (const s of signs) {
        expect(s.text, `seed ${seed}`).toBeTruthy();
        expect(s.text!.length).toBeLessThanOrEqual(SIGN_TEXT_MAX);
        expect(s.text).not.toMatch(/[{}]/);
        lines.add(s.text!);
      }
    }
    expect(lines.size).toBeGreaterThan(4);
  });
  it("sign text uses the setting's name where a template asks for it", () => {
    let named = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const b = brief({ setting: { ...STARTER_BRIEFS.dungeon.setting, name: "Hollow Reach" } });
      for (const s of interactables(generateMap(b, { seed, id: "m_a" }).map)) if (s.text?.includes("hollow reach")) named++;
    }
    expect(named).toBeGreaterThan(0);
  });
  it("a lever is linked to the nearest door when there are doors", () => {
    let linked = 0;
    for (const seed of SEEDS) {
      const map = generateMap(brief(), { seed, id: "m_a", doorObjects: true }).map;
      const doors = interactables(map).filter((o) => o.kind === "door");
      const lever = interactables(map).find((o) => o.kind === "lever")!;
      expect(lever.links).toHaveLength(INTERACT.levers.maxLinks);
      const near = Math.min(...doors.map((d) => Math.max(Math.abs(d.x - lever.x), Math.abs(d.y - lever.y))));
      const target = doors.find((d) => d.id === lever.links![0])!;
      expect(Math.max(Math.abs(target.x - lever.x), Math.abs(target.y - lever.y))).toBe(near);
      linked++;
    }
    expect(linked).toBe(SEEDS.length);
  });
  it("a lever with no door to link to is left unlinked (and the map still parses)", () => {
    const b = brief({ setting: { ...STARTER_BRIEFS.cave.setting }, rooms: STARTER_BRIEFS.cave.rooms, points_of_interest: [{ kind: "lever", room_id: "hollow" }], entity_slots: [], exits: STARTER_BRIEFS.cave.exits });
    const { map } = generateMap(b, { seed: 5, id: "m_c" });
    const lever = interactables(map).find((o) => o.kind === "lever")!;
    expect(lever.links).toBeUndefined();
    expect(MapSchema.safeParse(map).success).toBe(true);
  });
});

describe("population is deterministic and changes nothing else", () => {
  it("the same seed, tier and options give the same map", () => {
    expect(generateMap(brief(), { seed: 8, id: "m_a", doorObjects: true, tier: 2 }).map).toEqual(generateMap(brief(), { seed: 8, id: "m_a", doorObjects: true, tier: 2 }).map);
  });
  it("tiles, spawn, exits and entity slots are exactly what they were", () => {
    for (const seed of SEEDS) {
      const plain = generateMap(brief(), { seed, id: "m_a" }).map;
      const full = generateMap(brief(), { seed, id: "m_a", doorObjects: true, tier: 4 }).map;
      const keep = (m: GameMap) => getObjects(m).filter((o) => o.type !== "interactable");
      expect(keep(full)).toEqual(keep(plain));
      expect(full.layers.filter((l) => l.type === "tilelayer")).toEqual(plain.layers.filter((l) => l.type === "tilelayer"));
    }
  });
});

describe("a built map becomes containers when it is added to the game", () => {
  it("chests and the loot slot are stocked, deterministically", () => {
    const { map } = generateMap(STARTER_BRIEFS.dungeon, { seed: 3, id: "m_d" });
    const mk = () => addMap(createGameState({ seed: 1, bible: BIBLE, facts: FACTS, contentRating: "teen" }), map).state;
    const s = mk();
    const containers = Object.values(s.containers);
    const chests = interactables(map).filter((o) => o.kind === "chest");
    const slots = getObjects(map).filter((o) => o.type === "entity_slot" && o.role === "loot");
    expect(containers.filter((c) => c.kind === "chest")).toHaveLength(chests.length);
    expect(containers.filter((c) => c.kind === "pile")).toHaveLength(slots.length);
    for (const c of containers) {
      expect(c.map_id).toBe("m_d");
      expect(c.items.length).toBeGreaterThan(0);
    }
    expect(mk().containers).toEqual(s.containers);
  });
});
