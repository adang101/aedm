import { describe, expect, it } from "vitest";
import { ALTAR_BOONS, type AltarBoon, type MapObject } from "@aedm/schemas";
import { altarBoonOf, altarText, altarUsedBy, useAltar } from "./altars.ts";
import { startCombat } from "./combat.ts";
import { INTERACT } from "./data.ts";
import { describeEvent, type EngineEvent } from "./events.ts";
import { describeScene } from "./describe.ts";
import { examine, performAct } from "./interact.ts";
import { createRng } from "./rng.ts";
import { findInteractable, type GameState } from "./state.ts";
import { PARTY_IDS, makeWorld, placeAt, spawn, withArchetype, withState } from "./testkit.ts";

const [A, B, C] = PARTY_IDS as [string, string, string];
const MAP = "m_lighthouse";
const rng = (seed = 5) => createRng(seed);
const altar = (id: string, x: number, y: number, boon?: AltarBoon): MapObject =>
  ({ type: "interactable", id, kind: "altar", state: "closed", x, y, ...(boon ? { altar: { boon } } : {}) });
const types = (r: { events: { type: string }[] }) => r.events.map((e) => e.type);

function world(boon?: AltarBoon) {
  const w = makeWorld(7, { objects: [altar("altar_1", 5, 5, boon), altar("altar_2", 9, 9), altar("altar_3", 12, 12)] });
  return { ...w, state: placeAt(placeAt(placeAt(w.state, A, 5, 4), B, 5, 6), C, 18, 18) };
}

describe("altars", () => {
  it("mend heals a share of max HP (from data) and the event says how much", () => {
    const s = withState(world("mend").state, (x) => { x.entities[A]!.hp = 1; });
    const r = performAct(s, rng(), A, "interact", "altar_1");
    expect(r).toMatchObject({ ok: true, narrative: false });
    const want = Math.min(s.entities[A]!.hpMax - 1, Math.floor((s.entities[A]!.hpMax * INTERACT.altars.boons.mend.percentMaxHp) / 100));
    expect(r.state.entities[A]!.hp).toBe(1 + want);
    expect(r.state.characters[A]!.hp).toBe(1 + want);
    expect(types(r)).toEqual(["heal", "altar_used"]);
    expect(r.events.at(-1)).toMatchObject({ type: "altar_used", mapId: MAP, by: A, byName: "Brindle Ash", objectId: "altar_1", boon: "mend", amount: want });
  });
  it("ward gives a shield that absorbs damage, with a shielded condition", () => {
    const r = useAltar(world("ward").state, rng(), A, "altar_1");
    expect(r.state.entities[A]!.shield).toBe(INTERACT.altars.boons.ward.absorb);
    expect(r.state.entities[A]!.conditions.map((c) => c.condition)).toContain("shielded");
    expect(r.events.at(-1)).toMatchObject({ type: "altar_used", boon: "ward", amount: INTERACT.altars.boons.ward.absorb });
  });
  it("cleanse ends every harmful condition and keeps the helpful ones", () => {
    const s = withState(world("cleanse").state, (x) => {
      x.entities[A]!.conditions = [{ condition: "burning", turns: 3 }, { condition: "slowed", turns: 2 }, { condition: "hasted", turns: 2 }];
    });
    const r = useAltar(s, rng(), A, "altar_1");
    expect(r.state.entities[A]!.conditions.map((c) => c.condition)).toEqual(["hasted"]);
    expect(types(r)).toEqual(["condition_ended", "condition_ended", "altar_used"]);
    expect(r.events.at(-1)).toMatchObject({ boon: "cleanse", amount: 2 });
  });
  it("each character takes a boon once; a second try is ok, silent and changes nothing", () => {
    const first = useAltar(world("mend").state, rng(), A, "altar_1");
    expect(altarUsedBy(first.state, MAP, "altar_1", A)).toBe(true);
    const again = useAltar(first.state, rng(), A, "altar_1");
    expect(again.ok).toBe(true);
    expect(again.events).toEqual([{ type: "altar_silent", mapId: MAP, by: A, byName: "Brindle Ash", objectId: "altar_1" }]);
    expect(again.state.entities).toEqual(first.state.entities);
    expect(again.state.interactables).toEqual(first.state.interactables);
    // another character still can, and the other altars are untouched
    const other = useAltar(first.state, rng(), B, "altar_1");
    expect(types(other)).toContain("altar_used");
    expect(first.state.interactables["m_lighthouse/altar_1"]!.usedBy).toEqual([A]);
    expect(other.state.interactables["m_lighthouse/altar_1"]!.usedBy).toEqual([A, B]);
    expect(types(useAltar(placeAt(first.state, A, 9, 8), rng(), A, "altar_2"))).toContain("altar_used");
  });
  it("without a named boon the pick is deterministic from the map seed, map id and object id, and covers the list", () => {
    const s = world().state;
    const o = findInteractable(s, MAP, "altar_2")!;
    expect(altarBoonOf(s, MAP, o)).toBe(altarBoonOf(s, MAP, o));
    expect(ALTAR_BOONS).toContain(altarBoonOf(s, MAP, o));
    const r1 = useAltar(placeAt(s, A, 9, 8), rng(1), A, "altar_2");
    const r2 = useAltar(placeAt(s, A, 9, 8), rng(99), A, "altar_2");
    expect((r1.events.at(-1) as { boon: string }).boon).toBe((r2.events.at(-1) as { boon: string }).boon);
    const picks = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const ms = withState(s, (x) => { x.maps[MAP] = { ...x.maps[MAP]!, meta: { ...x.maps[MAP]!.meta, seed } }; });
      picks.add(altarBoonOf(ms, MAP, findInteractable(ms, MAP, "altar_3")!));
    }
    expect(picks).toEqual(new Set(ALTAR_BOONS));
  });
  it("needs reach and a live character; a made-up altar is refused", () => {
    expect(useAltar(world("mend").state, rng(), C, "altar_1").ok).toBe(false);
    expect(useAltar(world("mend").state, rng(), A, "altar_9").ok).toBe(false);
    expect(useAltar(withState(world("mend").state, (x) => { x.entities[A]!.hp = 0; }), rng(), A, "altar_1").ok).toBe(false);
  });
  it("costs the action in combat (a silent second try costs nothing)", () => {
    let s = world("mend").state;
    const a = withArchetype(s);
    s = spawn(a.state, rng(), a.id, 15, 15);
    const enemy = Object.values(s.entities).find((e) => e.kind === "enemy")!;
    const c = startCombat(s, rng(), [A, enemy.id], "standard");
    const mine = withState(c.state, (x) => { x.combat!.active_id = A; x.combat!.cursor = x.combat!.order.findIndex((o) => o.entity_id === A); x.combat!.turn = { movementLeft: 6, actionUsed: false, quickUsed: false }; });
    const r = useAltar(mine, rng(), A, "altar_1");
    expect(r.ok && r.state.combat!.turn.actionUsed).toBe(true);
    const silent = useAltar(withState(r.state, (x) => { x.combat!.turn.actionUsed = false; }), rng(), A, "altar_1");
    expect(silent.ok).toBe(true);
    expect(silent.state.combat!.turn.actionUsed).toBe(false);
    expect(useAltar(r.state, rng(), B, "altar_1").ok).toBe(false); // out of turn
  });
  it("examine gives an engine line, a different one once this character has used it", () => {
    const s = world("mend").state;
    const before = examine(s, rng(), A, "altar_1");
    expect(before).toMatchObject({ ok: true, narrative: false, text: INTERACT.texts.altar!.any });
    const used = useAltar(s, rng(), A, "altar_1").state;
    expect(examine(used, rng(), A, "altar_1").text).toBe(INTERACT.texts.altar!.used);
    expect(examine(used, rng(), B, "altar_1").text).toBe(INTERACT.texts.altar!.any);
    expect(describeScene(s, A)).toMatch(/an altar/);
  });
  it("talk to a creature stays with the DM, interact on a creature too", () => {
    expect(performAct(world().state, rng(), A, "interact", B)).toMatchObject({ ok: true, narrative: true });
    expect(performAct(world().state, rng(), A, "talk", B)).toMatchObject({ ok: true, narrative: true });
  });
  it("tells the table and the DM in words from data", () => {
    const r = useAltar(world("ward").state, rng(), A, "altar_1");
    const used = r.events.find((e) => e.type === "altar_used") as Extract<EngineEvent, { type: "altar_used" }>;
    expect(altarText(used)).toBe("Brindle Ash touches the altar, and a faint ward settles over them.");
    expect(describeEvent(used)).toBe("[engine: Brindle Ash takes the boon of altar altar_1: ward (8)]");
    const silent = useAltar(r.state, rng(), A, "altar_1").events[0] as Extract<EngineEvent, { type: "altar_silent" }>;
    expect(altarText(silent)).toBe("The altar is silent; it has nothing more for Brindle Ash.");
    expect(describeEvent(silent)).toBe("[engine: altar altar_1 has nothing more for Brindle Ash]");
  });
  it("is deterministic", () => {
    const s: GameState = world().state;
    expect(JSON.stringify(useAltar(s, rng(4), A, "altar_1"))).toBe(JSON.stringify(useAltar(s, rng(4), A, "altar_1")));
  });
});
