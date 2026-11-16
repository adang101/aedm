import type { EntityView, GameMap, MapObject, TileDef } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { buildScenes } from "../net/mock-world";
import { TILE } from "../render/camera";
import {
  classifyCreature, classifyTile, collectMarkers, creatureDots, exitSide, fitMinimap, minimapToCameraCenter, minimapToTile,
  rasterizeMap, tileColor, viewRect,
} from "./minimap";
import { SeenGrid } from "./seen";

const def = (gid: number, role: TileDef["role"], color = "#4f8a3c"): TileDef =>
  ({ gid, material_id: `mat_${gid}`, role, color, accent: color, pattern: "none", walkable: true, blocks_sight: false, variant: 0, layer: "ground" }) as TileDef;
const sprite = { kind: "shape", shape: "circle", color: "#4f8a3c", accent: "#f6e8a0", glyph: "A" } as const;
const ent = (id: string, kind: EntityView["kind"], extra: Partial<EntityView> = {}): EntityView =>
  ({ id, kind, name: id, x: 3, y: 4, hp: 5, hp_max: 5, conditions: [], sprite, ...extra }) as EntityView;

describe("tile reduction", () => {
  it("reads each material role as its own class", () => {
    expect(classifyTile(def(1, "floor"), undefined, undefined).cls).toBe("ground");
    expect(classifyTile(def(2, "path"), undefined, undefined).cls).toBe("path");
    expect(classifyTile(def(3, "liquid"), undefined, undefined).cls).toBe("water");
    expect(classifyTile(def(4, "hazard"), undefined, undefined).cls).toBe("hazard");
    expect(classifyTile(undefined, undefined, undefined).cls).toBe("void");
  });

  it("lets walls and trees win over the ground below", () => {
    expect(classifyTile(def(1, "floor"), def(5, "wall"), undefined).cls).toBe("wall");
    expect(classifyTile(def(1, "floor"), def(6, "obstacle"), undefined).cls).toBe("obstacle");
    expect(classifyTile(def(1, "floor"), undefined, def(6, "obstacle")).cls).toBe("obstacle");
    expect(classifyTile(def(1, "floor"), def(7, "door"), undefined).cls).toBe("door");
    expect(classifyTile(def(1, "floor"), undefined, def(8, "decor")).cls).toBe("ground");
  });

  it("gives each class a distinct colour", () => {
    const d = def(1, "floor");
    const colors = (["ground", "path", "water", "hazard", "wall", "obstacle", "door"] as const).map((c) => tileColor(c, d));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("rasterizes every tile of a real map and dims what has not been seen", () => {
    const map = buildScenes().m_hollowmere!.map;
    const lit = rasterizeMap(map, null);
    expect(lit.length).toBe(map.width * map.height * 4);
    expect(lit.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
    const seen = new SeenGrid(map.width, map.height);
    seen.reveal(5, 5, 2);
    const dim = rasterizeMap(map, seen);
    const at = (a: Uint8ClampedArray, x: number, y: number) => [...a.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 3)];
    expect(at(dim, 5, 5)).toEqual(at(lit, 5, 5));
    const far = at(dim, map.width - 2, map.height - 2), farLit = at(lit, map.width - 2, map.height - 2);
    expect(far[0]! + far[1]! + far[2]!).toBeLessThan(farLit[0]! + farLit[1]! + farLit[2]!);
  });
});

describe("creature dots", () => {
  it("tells the player, party, and each disposition apart by shape", () => {
    expect(classifyCreature(ent("a", "pc"), "a")).toBe("me");
    expect(classifyCreature(ent("b", "pc"), "a")).toBe("ally");
    expect(classifyCreature(ent("c", "enemy"), "a")).toBe("hostile");
    expect(classifyCreature(ent("d", "npc"), "a")).toBe("neutral");
    expect(classifyCreature(ent("e", "npc", { disposition: "friendly" }), "a")).toBe("friendly");
    expect(classifyCreature(ent("f", "npc", { disposition: "wary" }), "a")).toBe("wary");
    expect(classifyCreature(ent("g", "enemy", { disposition: "neutral" }), "a")).toBe("neutral");
  });

  it("skips the defeated and draws the player last", () => {
    const dots = creatureDots({
      me: ent("me", "pc"), ally: ent("ally", "pc"), orc: ent("orc", "enemy"), gone: ent("gone", "enemy", { hp: 0 }),
    }, "me");
    expect(dots.map((d) => d.id)).toEqual(["orc", "ally", "me"]);
  });
});

describe("markers", () => {
  const map = buildScenes().m_hollowmere!.map as GameMap;
  it("finds the edge an exit sits on", () => {
    expect(exitSide(0, 10, 40, 30)).toBe("w");
    expect(exitSide(39, 10, 40, 30)).toBe("e");
    expect(exitSide(20, 0, 40, 30)).toBe("n");
    expect(exitSide(20, 29, 40, 30)).toBe("s");
  });

  it("lists exits and visible things, never hidden ones, and loot piles that are not already a chest", () => {
    const objs: MapObject[] = [
      { type: "exit", name: "road", to: "m_x", target_entry: "a", x: 0, y: 5 },
      { type: "interactable", id: "c1", kind: "chest", state: "closed", x: 4, y: 4 },
      { type: "interactable", id: "c2", kind: "chest", state: "closed", x: 6, y: 6, hidden: true },
      { type: "spawn", name: "party_start", x: 1, y: 1 },
    ];
    const m = collectMarkers(map, objs, [
      { id: "k1", kind: "chest", x: 4, y: 4, item_count: 1, locked: false, open: false },
      { id: "k2", kind: "pile", x: 9, y: 9, item_count: 1, locked: false, open: false },
      { id: "k3", kind: "pockets", x: 2, y: 2, item_count: 1, locked: false, open: false },
    ]);
    expect(m.map((x) => `${x.kind}@${x.x},${x.y}`)).toEqual(["exit@0,5", "chest@4,4", "pile@9,9"]);
    expect(m[0]!.side).toBe("w");
    // landmarks come first (drawn underneath), named
    const withPlace = collectMarkers(map, objs, [], [{ name: "Village well", x: 7, y: 7 }]);
    expect(withPlace[0]).toEqual({ kind: "landmark", x: 7, y: 7, label: "Village well" });
  });
});

describe("geometry", () => {
  it("fits whole pixels per tile inside the box", () => {
    expect(fitMinimap(40, 30, 176, 150)).toEqual({ k: 4, width: 160, height: 120 });
    expect(fitMinimap(60, 60, 100, 100)).toEqual({ k: 2, width: 120, height: 120 });
    expect(fitMinimap(20, 20, 900, 900, 2, 12).k).toBe(12);
  });

  it("maps a click to a camera centre and a walk tile, inside the map", () => {
    expect(minimapToCameraCenter(40, 20, 4, 40, 30)).toEqual({ cx: 10 * TILE, cy: 5 * TILE });
    expect(minimapToTile(41, 23, 4, 40, 30)).toEqual({ x: 10, y: 5 });
    expect(minimapToTile(-50, 9999, 4, 40, 30)).toEqual({ x: 0, y: 29 });
  });

  it("frames the camera view in tiles, clamped to the map", () => {
    const v = viewRect({ cx: 20 * TILE, cy: 15 * TILE, zoom: 1 }, 600, 480, 40, 30);
    expect(v.x1 - v.x0).toBeCloseTo(600 / 1.25 / TILE);
    expect((v.x0 + v.x1) / 2).toBeCloseTo(20);
    const edge = viewRect({ cx: 0, cy: 0, zoom: 1 }, 600, 480, 40, 30);
    expect(edge.x0).toBe(0);
    expect(edge.y0).toBe(0);
  });
});
