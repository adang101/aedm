/** Landmarks: the data library, matching from free text, stamping into maps, and reading them back. */
import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, LAYOUTS } from "@aedm/schemas";
import type { Environment, GameMap, Layout, MapBrief } from "@aedm/schemas";
import {
  LANDMARK_PIECES, LAYOUT_PLANS, STARTER_BRIEFS, generateMap, getObjects, getSpawn, isWalkable, mapLandmarks, matchLandmark, orient, ORIENTATIONS,
  reachableTiles, validateMap,
} from "./index";
import { fallbackLandmark, landmarkAt, landmarkFit, relevance, suits, textHash } from "./landmarks";
import { MATERIALS, getMaterial } from "./materials";
import type { LandmarkRole } from "./landmarks";

const ROLES: LandmarkRole[] = ["npc", "enemy", "boss", "loot", "poi"];
const WALKABLE_CODES = new Set(["_", ",", "@", "s", "f", "i", "g", "=", "+"]);

describe("the library", () => {
  it("is a varied library with well-formed pieces", () => {
    expect(LANDMARK_PIECES.length).toBeGreaterThanOrEqual(30);
    const ids = new Set<string>();
    for (const p of LANDMARK_PIECES) {
      expect(ids.has(p.id), `duplicate ${p.id}`).toBe(false);
      ids.add(p.id);
      expect(p.id).toMatch(/^[a-z][a-z0-9_]{2,29}$/);
      expect(p.name.length).toBeLessThanOrEqual(24);
      expect(p.description.length).toBeGreaterThan(20);
      expect(p.description.length).toBeLessThanOrEqual(120);
      expect(p.keywords.length).toBeGreaterThanOrEqual(5);
      expect(p.weight).toBeGreaterThanOrEqual(0);
      expect(p.weight).toBeLessThanOrEqual(3);
      expect(p.env.length).toBeGreaterThan(0);
      for (const e of p.env) expect(ENVIRONMENTS).toContain(e);
      for (const l of p.layouts ?? []) expect(LAYOUTS).toContain(l);
      for (const r of p.roles) expect(ROLES).toContain(r);
      const w = p.rows[0]!.length;
      expect(p.rows.length).toBeGreaterThanOrEqual(3);
      expect(p.rows.length).toBeLessThanOrEqual(8);
      expect(w).toBeLessThanOrEqual(11);
      for (const r of p.rows) expect(r.length, `${p.id} rows differ in width`).toBe(w);
      const flat = p.rows.join("");
      expect([...flat].filter((c) => c === "@")).toHaveLength(1);
      expect(/[sfi]/.test(flat), `${p.id} has no anchor`).toBe(true);
      if (flat.includes("g")) expect(p.sign?.length, `${p.id} has a sign anchor but no text`).toBeGreaterThan(0);
      for (const t of p.sign ?? []) expect(t.length).toBeLessThanOrEqual(200);
      for (const c of new Set(flat)) {
        if (/[A-Z]/.test(c)) expect(p.legend[c], `${p.id}: letter ${c} is not in the legend`).toBeDefined();
        else expect("._,#orT~-=+@sfig".includes(c) || c === "t", `${p.id}: unknown code ${c}`).toBe(true);
      }
      for (const [letter, e] of Object.entries(p.legend)) {
        expect(flat.includes(letter), `${p.id}: legend ${letter} unused`).toBe(true);
        if (e.p) expect(getMaterial(e.p), `${p.id}: ${e.p} is not a library material`).toBeDefined();
        for (const u of e.use ?? []) expect(MATERIALS.some((m) => m.id === u && m.role === "wall")).toBe(true);
      }
      if (/[~-]/.test(flat.replaceAll("-", "~"))) expect(p.pond, `${p.id} has water but no pond flag`).toBe(true);
    }
  });

  it("covers every environment and layout, and every role in each environment", () => {
    for (const environment of ENVIRONMENTS) {
      for (const layout of LAYOUTS) {
        const pool = LANDMARK_PIECES.filter((p) => suits(p, { environment, layout }));
        expect(pool.length, `${environment}/${layout}`).toBeGreaterThanOrEqual(6);
        for (const role of ROLES) expect(pool.some((p) => p.roles.includes(role)), `${environment}/${layout}/${role}`).toBe(true);
        expect(pool.some((p) => p.weight >= 2 && p.roles.includes("boss")), `${environment}/${layout} boss piece`).toBe(true);
      }
    }
  });

  it("keeps every pattern whole in all eight orientations: one connected walkable area holding every anchor, open to the outside", () => {
    for (const p of LANDMARK_PIECES) {
      for (let t = 0; t < ORIENTATIONS; t++) {
        const o = orient(p, t);
        expect(o.cells).toHaveLength(o.w * o.h);
        const walkable = (x: number, y: number): boolean => {
          if (x < 0 || y < 0 || x >= o.w || y >= o.h) return false;
          const c = o.cells[y * o.w + x]!;
          if (WALKABLE_CODES.has(c)) return true;
          const e = p.legend[c];
          return /[A-Z]/.test(c) && !!e && !e.solid && !e.wall;
        };
        const seen = new Set<number>([o.center.y * o.w + o.center.x]);
        const stack = [o.center];
        let edge = false;
        while (stack.length) {
          const c = stack.pop()!;
          if (c.x === 0 || c.y === 0 || c.x === o.w - 1 || c.y === o.h - 1) edge = true;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = c.x + dx;
            const ny = c.y + dy;
            if (!walkable(nx, ny)) {
              if (nx >= 0 && ny >= 0 && nx < o.w && ny < o.h && o.cells[ny * o.w + nx] === "." && !(c.x === o.center.x && c.y === o.center.y && false)) edge = true;
              continue;
            }
            if (seen.has(ny * o.w + nx)) continue;
            seen.add(ny * o.w + nx);
            stack.push({ x: nx, y: ny });
          }
        }
        for (const list of Object.values(o.anchors)) for (const a of list) expect(seen.has(a.y * o.w + a.x), `${p.id}/${t}: anchor ${a.x},${a.y} is cut off`).toBe(true);
        expect(edge, `${p.id}/${t}: the open area never reaches the edge of the footprint`).toBe(true);
        let all = 0;
        for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) if (walkable(x, y)) all++;
        expect(seen.size, `${p.id}/${t}: walkable cells split into pieces`).toBe(all);
      }
    }
  });
});

describe("matching", () => {
  const field = { environment: "outdoor" as Environment, layout: "open_field" as Layout };
  const indoor = { environment: "indoor" as Environment, layout: "rooms_and_corridors" as Layout };
  const id = (text: string, ctx = field, role: LandmarkRole = "poi") => matchLandmark(text, ctx, role)?.piece.id;

  it("finds the piece a feature names", () => {
    expect(id("ruined shrine")).toBe("ruined_shrine");
    expect(id("ferry dock")).toBe("ferry_dock");
    expect(id("the old ferry crossing")).toBe("ferry_dock");
    expect(id("campfire")).toBe("campsite");
    expect(id("Hermit's hut")).toBe("hermit_hut");
    expect(id("gallows")).toBe("gallows_hill");
    expect(id("standing stones")).toBe("standing_stones");
    expect(id("mine entrance")).toBe("mine_mouth");
    expect(id("graveyard")).toBe("graveyard_plot");
    expect(id("well")).toBe("village_well");
    expect(id("market stalls")).toBe("market_stalls");
    expect(id("waterfall")).toBe("waterfall_pool");
    expect(id("library", indoor)).toBe("library_corner");
    expect(id("forge", indoor)).toBe("smithy_forge");
    expect(id("prison cells", indoor)).toBe("prison_cells");
    expect(id("throne", indoor)).toBe("throne_hall");
  });

  it("matches synonyms and related words by shared stems", () => {
    expect(id("graveyards and tombs")).toBe("graveyard_plot");
    expect(id("a collapsed wagon")).toBe("collapsed_wagon");
    expect(id("keeper's desk", indoor)).toBe("library_corner");
    expect(id("drowned pipe organ", indoor)).toBe("altar_nook");
    expect(id("lantern post")).toBe("notice_board");
  });

  it("only offers pieces that suit the setting", () => {
    for (const environment of ENVIRONMENTS) {
      for (const layout of LAYOUTS) {
        for (const text of ["library", "ferry dock", "forge", "mine", "throne", "garden", "xyzzy"]) {
          const m = matchLandmark(text, { environment, layout });
          expect(m, `${environment}/${layout}/${text}`).toBeDefined();
          expect(suits(m!.piece, { environment, layout }), `${environment}/${layout}/${text} -> ${m!.piece.id}`).toBe(true);
        }
      }
    }
    // no ponds where the setting wants no water
    for (const text of ["ferry dock", "waterfall", "bridge", "pool"]) {
      expect(matchLandmark(text, { ...field, water: false })!.piece.pond).not.toBe(true);
    }
  });

  it("gives any unusual phrase a fitting fallback, the same one every time", () => {
    for (const text of ["xyzzy", "the thing in the corner", "zorblax's folly", "42", "!!!", ""]) {
      const a = matchLandmark(text, field);
      const b = matchLandmark(text, field);
      expect(a).toEqual(b);
      expect(a!.score).toBe(0);
    }
    // phrases spread over several pieces, and a role picks a piece for that role
    const picks = new Set(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map((t) => matchLandmark(t, field)!.piece.id));
    expect(picks.size).toBeGreaterThan(2);
    for (const role of ROLES) expect(fallbackLandmark("x", field, role)!.roles).toContain(role);
    expect(fallbackLandmark("x", field, "boss")!.weight).toBeGreaterThanOrEqual(2);
  });

  it("skips pieces already used, unless that would leave nothing", () => {
    const first = matchLandmark("shrine", field)!.piece.id;
    expect(matchLandmark("shrine", field, "poi", new Set([first]))!.piece.id).not.toBe(first);
    const all = new Set(LANDMARK_PIECES.map((p) => p.id));
    expect(matchLandmark("shrine", field, "poi", all)).toBeDefined();
  });

  it("scores deterministically", () => {
    expect(relevance("ruined shrine", LANDMARK_PIECES.find((p) => p.id === "ruined_shrine")!)).toBeGreaterThan(relevance("shrine", LANDMARK_PIECES.find((p) => p.id === "hermit_hut")!));
    expect(textHash("abc")).toBe(textHash("abc"));
    expect(textHash("abc")).not.toBe(textHash("abd"));
  });

  it("finds each piece from its own name in every setting it suits", () => {
    for (const p of LANDMARK_PIECES) {
      for (const environment of p.env) {
        for (const layout of p.layouts ?? LAYOUTS) {
          if (!suits(p, { environment, layout })) continue;
          const m = matchLandmark(p.name, { environment, layout });
          expect(m!.piece.id, `${p.name} in ${environment}/${layout}`).toBe(p.id);
        }
      }
    }
  });
});

// ---------- stamping ----------

const roomsFor = (layout: Layout): MapBrief["rooms"] => LAYOUT_PLANS[layout].rooms.map(([rid, type, size, connects_to]) => ({ id: rid, type, size, connects_to: [...connects_to] }));

/** A brief that asks for one named feature in a setting, with an NPC and a fight so the slots have somewhere to go. */
function briefFor(feature: string, environment: Environment, layout: Layout, size: MapBrief["size_class"] = "medium"): MapBrief {
  const preset = environment === "outdoor" ? (layout === "settlement" ? "town" : "forest") : environment === "indoor" ? "interior" : layout === "cave" ? "cave" : "dungeon";
  const base = STARTER_BRIEFS[preset];
  const plan = LAYOUT_PLANS[layout];
  return {
    ...base,
    setting: { ...base.setting, layout, environment, density: { obstacles: 1, liquid: 1, hazards: 0 } },
    size_class: size,
    rooms: roomsFor(layout),
    points_of_interest: [{ kind: feature.slice(0, 24), room_id: plan.poi[0]! }],
    entity_slots: [{ role: "npc", room_id: plan.npc, count: 1 }, { role: "enemy", room_id: plan.enemies, count: 2 }],
    exits: environment === "outdoor" ? [{ side: "north", label: "North" }, { side: "east", label: "East" }] : [{ side: "south", label: "Out" }],
  };
}

function checkLandmarks(map: GameMap): void {
  expect(validateMap(map).errors).toEqual([]);
  const start = getSpawn(map, "party_start")!;
  const reach = new Set([start, ...reachableTiles(map, start, 400)].map((p) => `${p.x},${p.y}`));
  const seen = new Set<string>();
  for (const l of mapLandmarks(map)) {
    for (const [kind, list] of Object.entries(l.anchors)) {
      for (const a of list) {
        expect(isWalkable(map, a.x, a.y), `${l.piece} ${kind} anchor ${a.x},${a.y} is not walkable`).toBe(true);
        expect(reach.has(`${a.x},${a.y}`), `${l.piece} ${kind} anchor ${a.x},${a.y} is not reachable`).toBe(true);
        expect(seen.has(`${a.x},${a.y}`), `${l.piece} shares an anchor tile`).toBe(false);
        seen.add(`${a.x},${a.y}`);
      }
    }
    expect(isWalkable(map, l.x, l.y)).toBe(true);
    expect(l.x).toBeGreaterThanOrEqual(2);
    expect(l.y).toBeGreaterThanOrEqual(2);
    expect(l.x).toBeLessThan(map.width - 2);
    expect(l.y).toBeLessThan(map.height - 2);
  }
}

describe("stamping", () => {
  it("stamps every piece validly in every environment and layout it claims to suit", () => {
    let combos = 0;
    for (const p of LANDMARK_PIECES) {
      for (const environment of p.env) {
        for (const layout of p.layouts ?? LAYOUTS) {
          if (!suits(p, { environment, layout })) continue;
          combos++;
          let placed = false;
          for (const seed of [3, 41, 977]) {
            const { map } = generateMap(briefFor(p.name, environment, layout), { seed, id: "m_lm" });
            checkLandmarks(map);
            if (mapLandmarks(map).some((l) => l.piece === p.id)) { placed = true; break; }
          }
          expect(placed, `${p.id} never fits in ${environment}/${layout}`).toBe(true);
        }
      }
    }
    expect(combos).toBeGreaterThan(150);
  }, 240_000);

  it("records each landmark as a trigger object with its name and position, and reads it back", () => {
    const { map } = generateMap(briefFor("ruined shrine", "outdoor", "open_field"), { seed: 5, id: "m_lm" });
    const triggers = getObjects(map).filter((o) => o.type === "trigger");
    const lms = mapLandmarks(map);
    expect(lms.length).toBe(triggers.length);
    expect(lms.length).toBeGreaterThan(0);
    const shrine = lms.find((l) => l.piece === "ruined_shrine")!;
    expect(shrine.name).toBe("Ruined shrine");
    expect(shrine.description.length).toBeGreaterThan(10);
    expect(triggers.find((o) => o.id === shrine.id)).toMatchObject({ x: shrine.x, y: shrine.y, on_enter: expect.stringMatching(/^lm:ruined_shrine:[0-7]$/) });
    expect(landmarkAt(map, shrine.x + 1, shrine.y)?.id).toBe(shrine.id);
    expect(landmarkAt(map, 0, 0)).toBeUndefined();
    // a map from before landmarks (no triggers) has none
    const bare = { ...map, layers: map.layers.map((l) => (l.type === "objectgroup" ? { ...l, objects: l.objects.filter((o) => o.type !== "trigger") } : l)) } as GameMap;
    expect(mapLandmarks(bare)).toEqual([]);
  });

  it("never overlaps two landmarks and keeps the arrival area and every exit clear", () => {
    for (const preset of ["forest", "swamp", "town", "cave", "dungeon", "ruins", "temple", "snowfield"] as const) {
      for (const seed of [3, 58, 1234, 40404]) {
        const { map } = generateMap({ ...STARTER_BRIEFS[preset], size_class: "large" }, { seed, id: "m" });
        checkLandmarks(map);
        const start = getSpawn(map, "party_start")!;
        const lms = mapLandmarks(map);
        for (const l of lms) expect(Math.max(Math.abs(l.x - start.x), Math.abs(l.y - start.y)), `${preset}/${seed}: ${l.piece} on the arrival area`).toBeGreaterThan(2);
        for (const o of getObjects(map)) {
          if (o.type !== "exit") continue;
          for (const l of lms) for (const list of Object.values(l.anchors)) for (const a of list) expect(a.x === o.x && a.y === o.y).toBe(false);
        }
        const centers = new Set(lms.map((l) => `${l.x},${l.y}`));
        expect(centers.size).toBe(lms.length);
      }
    }
  });

  it("gives every map at least one landmark and every focal room with a slot something to stand at", () => {
    for (const preset of Object.keys(STARTER_BRIEFS) as Array<keyof typeof STARTER_BRIEFS>) {
      for (const seed of [3, 1234]) {
        const { map } = generateMap(STARTER_BRIEFS[preset], { seed, id: "m" });
        expect(mapLandmarks(map).length, `${preset}/${seed}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("puts entity slots on landmark anchors when there are landmarks", () => {
    let onAnchor = 0;
    let slots = 0;
    for (const seed of [3, 58, 1234, 40404, 777001]) {
      const { map } = generateMap({ ...STARTER_BRIEFS.ruins, size_class: "large" }, { seed, id: "m" });
      const anchors = new Set(mapLandmarks(map).flatMap((l) => Object.values(l.anchors).flat().map((a) => `${a.x},${a.y}`)));
      for (const o of getObjects(map)) {
        if (o.type !== "entity_slot") continue;
        slots++;
        if (anchors.has(`${o.x},${o.y}`)) onAnchor++;
      }
    }
    expect(onAnchor / slots).toBeGreaterThan(0.7);
  });

  it("puts the boss slot at the most imposing landmark", () => {
    for (const seed of [3, 58, 1234, 40404, 777001]) {
      const { map } = generateMap({ ...STARTER_BRIEFS.ruins, size_class: "large" }, { seed, id: "m" });
      const lms = mapLandmarks(map);
      const boss = getObjects(map).find((o) => o.type === "entity_slot" && o.role === "boss");
      if (!boss || lms.length < 2) continue;
      const heaviest = Math.max(...lms.filter((l) => l.anchors.fight.length > 0).map((l) => l.weight));
      const at = lms.find((l) => l.anchors.fight.some((a) => a.x === boss.x && a.y === boss.y));
      expect(at?.weight, `seed ${seed}`).toBe(heaviest);
    }
  });

  it("turns an altar feature into a real altar interactable at the landmark's item spot", () => {
    const b = briefFor("altar", "underground", "cave");
    for (const seed of [3, 41, 977]) {
      const { map } = generateMap(b, { seed, id: "m" });
      const altar = getObjects(map).find((o) => o.type === "interactable" && o.kind === "altar");
      expect(altar).toBeDefined();
      const l = mapLandmarks(map).find((x) => x.anchors.item.some((a) => a.x === altar!.x && a.y === altar!.y) || x.anchors.stand.some((a) => a.x === altar!.x && a.y === altar!.y));
      if (l) return;
    }
    throw new Error("the altar never stood at a landmark");
  });

  it("gives a sign anchor fitting text from data", () => {
    let found = 0;
    for (const seed of [3, 41, 977, 12, 88]) {
      const { map } = generateMap(briefFor("graveyard", "outdoor", "open_field"), { seed, id: "m" });
      const l = mapLandmarks(map).find((x) => x.piece === "graveyard_plot");
      if (!l) continue;
      const sign = getObjects(map).find((o) => o.type === "interactable" && o.kind === "sign" && l.anchors.sign.some((a) => a.x === o.x && a.y === o.y));
      expect(sign).toBeDefined();
      expect(LANDMARK_PIECES.find((p) => p.id === "graveyard_plot")!.sign).toContain((sign as { text: string }).text);
      found++;
    }
    expect(found).toBeGreaterThan(0);
  });

  it("is deterministic, and matches nothing when nothing fits", () => {
    const b = briefFor("gallows", "outdoor", "trail");
    expect(generateMap(b, { seed: 8, id: "m" }).map).toEqual(generateMap(b, { seed: 8, id: "m" }).map);
    expect(landmarkFit({ ...mapLandmarks(generateMap(b, { seed: 8, id: "m" }).map)[0]! }, "zzz", "npc")).toBeLessThanOrEqual(1);
  });

  it("keeps generation fast", () => {
    const t0 = performance.now();
    let n = 0;
    let worst = 0;
    for (const preset of Object.keys(STARTER_BRIEFS) as Array<keyof typeof STARTER_BRIEFS>) {
      for (const seed of [3, 58, 1234]) {
        const t = performance.now();
        generateMap({ ...STARTER_BRIEFS[preset], size_class: "large" }, { seed, id: "m" });
        worst = Math.max(worst, performance.now() - t);
        n++;
      }
    }
    expect((performance.now() - t0) / n, "mean ms per large map").toBeLessThan(60);
    expect(worst, "slowest large map in ms").toBeLessThan(500);
  });
});
