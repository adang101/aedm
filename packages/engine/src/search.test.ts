import { describe, expect, it } from "vitest";
import type { MapObject } from "@aedm/schemas";
import { startCombat } from "./combat.ts";
import { describeEvent, type EngineEvent } from "./events.ts";
import { performAct } from "./interact.ts";
import { openContainer } from "./inventory.ts";
import { describeScene } from "./describe.ts";
import { createRng } from "./rng.ts";
import { search, searchDc, searchedText } from "./search.ts";
import { containerDiff, containerSummaries, findInteractableAny, objectKey, type GameState } from "./state.ts";
import { PARTY_IDS, makeWorld, placeAt, spawn, withArchetype, withState } from "./testkit.ts";

const [A, B, C] = PARTY_IDS as [string, string, string];
const MAP = "m_lighthouse";
const rng = (seed = 5) => createRng(seed);
const trap = (id: string, x: number, y: number, dc = 12): MapObject =>
  ({ type: "interactable", id, kind: "trap", state: "closed", hidden: true, x, y, trap: { dc, dice: "1d6", damage_type: "sharp" } });
const chest = (id: string, x: number, y: number): MapObject => ({ type: "interactable", id, kind: "chest", state: "closed", hidden: true, x, y });

function world(objects: MapObject[]) {
  const w = makeWorld(7, { objects });
  return { ...w, state: placeAt(placeAt(placeAt(w.state, A, 5, 5), B, 18, 18), C, 18, 17) };
}
type Searched = Extract<EngineEvent, { type: "searched" }>;
const searched = (r: { events: EngineEvent[] }): Searched => r.events.find((e) => e.type === "searched") as Searched;
const searchedBy = (s: GameState, id: string): string[] => s.interactables[objectKey(MAP, id)]?.searchedBy ?? [];
const revealed = (s: GameState, id: string): boolean => s.interactables[objectKey(MAP, id)]?.revealed === true;

describe("search", () => {
  const objs = [trap("trap_1", 6, 5, 12), trap("trap_2", 8, 5, 20), chest("chest_1", 5, 7), trap("trap_far", 12, 5, 5)];

  it("reveals each hidden object in radius whose DC the one roll reaches, and remembers the searcher for the rest", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 80; seed++) {
      const s = world(objs).state;
      const r = search(s, rng(seed), A);
      expect(r.ok).toBe(true);
      const e = searched(r);
      expect(r.events.map((x) => x.type)).toEqual(["searched"]); // no roll event: it would show a DC
      expect(e.nothingNew).toBeUndefined();
      const dcs = { trap_1: 12, trap_2: 20, chest_1: searchDc(s, findInteractableAny(s, MAP, "chest_1")!) };
      for (const [id, dc] of Object.entries(dcs)) {
        const hit = e.total! >= dc;
        expect(revealed(r.state, id), `${id} total ${e.total}`).toBe(hit);
        expect(searchedBy(r.state, id)).toEqual(hit ? [] : [A]);
        expect(e.found.some((f) => f.objectId === id)).toBe(hit);
        seen.add(`${id}:${hit}`);
      }
      // out of radius: untouched
      expect(revealed(r.state, "trap_far")).toBe(false);
      expect(searchedBy(r.state, "trap_far")).toEqual([]);
    }
    expect(seen.has("trap_1:true") && seen.has("trap_1:false") && seen.has("trap_2:false")).toBe(true);
  });
  it("the DC of a hidden chest comes from data by the party loot tier", () => {
    const s = world(objs).state;
    expect(searchDc(s, findInteractableAny(s, MAP, "chest_1")!)).toBe(10);
    expect(searchDc(s, findInteractableAny(s, MAP, "trap_1")!)).toBe(12);
  });
  it("each character tries each object once; another character still can", () => {
    // a seed where Brindle fails
    let failed: GameState | undefined;
    for (let seed = 1; seed <= 200 && !failed; seed++) {
      const r = search(world([trap("trap_1", 6, 5, 30)]).state, rng(seed), A);
      if (searched(r).found.length === 0 && !searched(r).nothingNew) failed = r.state;
    }
    expect(searchedBy(failed!, "trap_1")).toEqual([A]);
    const again = search(failed!, rng(1), A);
    expect(searched(again)).toMatchObject({ found: [], nothingNew: true });
    expect(again.state.rngState).toBe(rng(1).state()); // the rng was not advanced: no die rolled
    expect(searchedBy(again.state, "trap_1")).toEqual([A]);
    const other = search(placeAt(failed!, B, 5, 6), rng(1), B);
    expect(searched(other).nothingNew).toBeUndefined();
    expect(searchedBy(other.state, "trap_1")).toEqual([A, B]);
  });
  it("a search that rolled and found nothing reads exactly like one with nothing to roll against", () => {
    const hard = world([trap("trap_1", 6, 5, 30)]).state;
    const rolled = (() => {
      for (let seed = 1; seed <= 200; seed++) {
        const r = search(hard, rng(seed), A);
        if (searched(r).found.length === 0) return r;
      }
      throw new Error("no failing seed");
    })();
    const empty = search(world([]).state, rng(), A);
    expect(searched(rolled).nothingNew).toBeUndefined();
    expect(searched(empty).nothingNew).toBe(true);
    expect(searchedText(searched(rolled))).toBe(searchedText(searched(empty)));
    expect(describeEvent(searched(rolled))).toBe(describeEvent(searched(empty)));
    expect(searchedText(searched(empty))).toBe("Brindle Ash searches carefully but finds nothing new.");
    expect(rolled.ok && empty.ok).toBe(true);
    expect(rolled.events.map((e) => e.type)).toEqual(empty.events.map((e) => e.type));
  });
  it("a found object is announced in plain words and reaches the client in interactables_revealed", () => {
    let hit: ReturnType<typeof search> | undefined;
    const s = world([trap("trap_1", 6, 5, 5)]).state; // DC 5: any roll but a very low one finds it
    for (let seed = 1; seed <= 50 && !hit; seed++) {
      const r = search(s, rng(seed), A);
      if (searched(r).found.length > 0) hit = r;
    }
    expect(searchedText(searched(hit!))).toBe("Brindle Ash searches and finds a trap.");
    expect(describeEvent(searched(hit!))).toBe("[engine: Brindle Ash searches and finds a trap at (6,5)]");
    expect(containerDiff(s, hit!.state, MAP).interactables_revealed).toEqual([
      { map_id: MAP, object: { type: "interactable", id: "trap_1", kind: "trap", state: "closed", x: 6, y: 5 } },
    ]);
  });
  it("a hidden chest has no container the table can see or open until it is found", () => {
    const s = world([chest("chest_1", 5, 6)]).state;
    expect(openContainer(s, rng(), A, "chest_1")).toMatchObject({ ok: false, error: "there is no such container" });
    const mine = (st: GameState) => containerSummaries(st, MAP).filter((c) => c.object_id === "chest_1");
    expect(mine(s)).toEqual([]);
    expect(performAct(s, rng(), A, "open", "chest_1").ok).toBe(false);
    let found: ReturnType<typeof search> | undefined;
    for (let seed = 1; seed <= 80 && !found; seed++) {
      const r = search(s, rng(seed), A);
      if (searched(r).found.length > 0) found = r;
    }
    const d = containerDiff(s, found!.state, MAP);
    expect(d.interactables_revealed?.[0]?.object.kind).toBe("chest");
    expect(mine(found!.state)).toHaveLength(1);
    expect(performAct(found!.state, rng(), A, "open", "chest_1").ok).toBe(true);
  });
  it("a hidden chest is not in the scene description, a found one is", () => {
    const s = world([chest("chest_1", 5, 6)]).state;
    const count = (t: string) => (t.match(/chest/g) ?? []).length;
    const before = count(describeScene(s, A));
    let found: ReturnType<typeof search> | undefined;
    for (let seed = 1; seed <= 80 && !found; seed++) {
      const r = search(s, rng(seed), A);
      if (searched(r).found.length > 0) found = r;
    }
    expect(count(describeScene(found!.state, A))).toBe(before + 1);
  });
  it("is free outside combat and costs the action in combat, whether it rolled or not", () => {
    let s = world([trap("trap_1", 6, 5, 12)]).state;
    const a = withArchetype(s);
    s = spawn(a.state, rng(), a.id, 15, 15);
    const enemy = Object.values(s.entities).find((e) => e.kind === "enemy")!;
    const c = startCombat(s, rng(), [A, enemy.id], "standard");
    const mine = withState(c.state, (x) => { x.combat!.active_id = A; x.combat!.cursor = x.combat!.order.findIndex((o) => o.entity_id === A); x.combat!.turn = { movementLeft: 6, actionUsed: false, quickUsed: false }; });
    const r = search(mine, rng(), A);
    expect(r.ok).toBe(true);
    expect(r.state.combat!.turn.actionUsed).toBe(true);
    expect(search(r.state, rng(), A).ok).toBe(false);
    const none = search(withState(mine, (x) => { x.interactables = { [objectKey(MAP, "trap_1")]: { revealed: true } }; }), rng(), A);
    expect(none.state.combat!.turn.actionUsed).toBe(true);
  });
  it("is reached through performAct without a target, and is deterministic", () => {
    const s = world(objs).state;
    const a = performAct(s, rng(3), A, "search");
    const b = search(s, rng(3), A);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(a.narrative).toBe(false);
    expect(JSON.stringify(search(s, rng(3), A).events)).toBe(JSON.stringify(b.events));
  });
  it("refuses a character that is down or unknown", () => {
    const s = withState(world(objs).state, (x) => { x.entities[A]!.hp = 0; });
    expect(search(s, rng(), A).ok).toBe(false);
    expect(search(s, rng(), "nobody").ok).toBe(false);
  });
});
