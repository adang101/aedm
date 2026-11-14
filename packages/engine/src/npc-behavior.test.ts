import { describe, expect, it } from "vitest";
import type { MapObject } from "@aedm/schemas";
import { aggroCheck, alliesWithParty, followStep, moveAlliesToScene, placePartyWithAllies } from "./npc-behavior.ts";
import { endCombat, enemyTakeTurn, startCombat } from "./combat.ts";
import { RULES } from "./data.ts";
import { applyDmActions } from "./dm-actions.ts";
import { addMap } from "./map-state.ts";
import { cloneState, placePartyOnMap, type GameState, type Mut } from "./state.ts";
import { chorister, makeTestMap, makeWorld, PARTY_IDS, placeAt, spawn, withArchetype, withState } from "./testkit.ts";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const CTX = { presentCharacterIds: PARTY_IDS, partyLevel: 1 };

/** Party gathered at (2,2), one enemy at `at`. */
function withEnemy(at: [number, number], opts: Parameters<typeof makeWorld>[1] = {}) {
  const w = makeWorld(7, opts);
  const a = withArchetype(w.state);
  let s = spawn(a.state, w.rng, a.id, at[0], at[1]);
  s = placeAt(placeAt(placeAt(s, "ch_brindle", 2, 2), "ch_tamsin", 2, 3), "ch_orrin", 3, 2);
  const id = Object.values(s.entities).find((e) => e.kind === "enemy")!.id;
  return { ...w, state: s, enemyId: id };
}

function addNpc(state: GameState, rng: ReturnType<typeof makeWorld>["rng"], name: string, role: "ally" | "bystander" | "villain", x: number, y: number): { state: GameState; id: string } {
  const r = applyDmActions(state, rng, [{ type: "create_npc", name, concept: "A local.", role, map_id: "m_lighthouse", x, y, sprite_tags: ["coat"] }], CTX);
  if (r.rejected.length > 0) throw new Error(r.rejected.map((x) => x.reason).join("; "));
  return { state: r.state, id: Object.values(r.state.npcs).find((n) => n.name === name)!.id };
}

const door = (id: string, x: number, y: number, state: "open" | "closed"): MapObject => ({ type: "interactable", id, kind: "door", state, x, y });

describe("aggroCheck", () => {
  it("starts a fight when an enemy sees a party character inside the radius", () => {
    const f = withEnemy([8, 2]);
    const a = aggroCheck(f.state)!;
    expect(a.enemyIds).toEqual([f.enemyId]);
    expect(a.participants).toEqual(expect.arrayContaining([...PARTY_IDS, f.enemyId]));
    expect(startCombat(f.state, f.rng, a.participants, "standard").ok).toBe(true);
  });
  it("does nothing when the enemy is too far away", () => {
    expect(aggroCheck(withEnemy([18, 18]).state)).toBeNull();
  });
  it("walls block sight", () => {
    const wall: [number, number][] = [[5, 1], [5, 2], [5, 3], [5, 4], [5, 0], [5, 5], [5, 6]];
    expect(aggroCheck(withEnemy([8, 2], { walls: wall }).state)).toBeNull();
  });
  it("a closed door blocks sight and an open one does not", () => {
    const wall: [number, number][] = [[5, 0], [5, 1], [5, 3], [5, 4], [5, 5], [5, 6], [5, 7]];
    expect(aggroCheck(withEnemy([8, 2], { walls: wall, objects: [door("d1", 5, 2, "closed")] }).state)).toBeNull();
    expect(aggroCheck(withEnemy([8, 2], { walls: wall, objects: [door("d1", 5, 2, "open")] }).state)).not.toBeNull();
  });
  it("is silent during combat", () => {
    const f = withEnemy([8, 2]);
    const r = startCombat(f.state, f.rng, aggroCheck(f.state)!.participants, "standard");
    expect(aggroCheck(r.state)).toBeNull();
  });
  it("ignores downed party characters", () => {
    const f = withEnemy([8, 2]);
    const s = withState(f.state, (x) => { for (const id of PARTY_IDS) x.entities[id]!.hp = 0; });
    expect(aggroCheck(s)).toBeNull();
  });
  it("ignores dead enemies, surrendered enemies (now NPCs) and calm NPCs", () => {
    const f = withEnemy([8, 2]);
    expect(aggroCheck(withState(f.state, (x) => { x.entities[f.enemyId]!.hp = 0; }))).toBeNull();
    const n = addNpc(f.state, f.rng, "Bystander Bo", "bystander", 6, 2);
    const v = addNpc(n.state, f.rng, "Grey Mara", "villain", 6, 4);
    expect(aggroCheck(withState(v.state, (x) => { delete x.entities[f.enemyId]; }))).toBeNull();
    const surrendered = withState(f.state, (x) => { Object.assign(x.entities[f.enemyId]!, { kind: "npc", disposition: "wary" }); });
    expect(aggroCheck(surrendered)).toBeNull();
  });
  it("only hostiles on the current map count", () => {
    const f = withEnemy([8, 2]);
    const s = withState(f.state, (x) => { x.entities[f.enemyId]!.mapId = "m_elsewhere"; });
    expect(aggroCheck(s)).toBeNull();
  });
  it("nearby enemies join the fight; distant ones stay out unless joinAll", () => {
    const w = makeWorld(7);
    const a = withArchetype(w.state);
    let s = spawn(a.state, w.rng, a.id, 8, 2);
    s = spawn(s, w.rng, a.id, 12, 3);
    s = spawn(s, w.rng, a.id, 19, 19);
    s = placeAt(placeAt(placeAt(s, "ch_brindle", 2, 2), "ch_tamsin", 2, 3), "ch_orrin", 3, 2);
    const enemies = Object.values(s.entities).filter((e) => e.kind === "enemy").map((e) => e.id);
    const r = aggroCheck(s)!;
    expect(r.enemyIds).toEqual([enemies[0]]);
    expect(r.participants).toContain(enemies[1]);
    expect(r.participants).not.toContain(enemies[2]);
  });
  it("the data switches work: joinAll pulls in every hostile, enabled=false silences aggro", () => {
    const w = makeWorld(7);
    const a = withArchetype(w.state);
    let s = spawn(a.state, w.rng, a.id, 8, 2);
    s = spawn(s, w.rng, a.id, 19, 19);
    s = placeAt(placeAt(placeAt(s, "ch_brindle", 2, 2), "ch_tamsin", 2, 3), "ch_orrin", 3, 2);
    const cfg = RULES.ai.aggro;
    try {
      cfg.joinAll = true;
      expect(aggroCheck(s)!.participants.filter((p) => p.startsWith("ei_"))).toHaveLength(2);
      cfg.enabled = false;
      expect(aggroCheck(s)).toBeNull();
    } finally {
      cfg.joinAll = false;
      cfg.enabled = true;
    }
  });
  it("includes allied NPCs among the participants", () => {
    const f = withEnemy([8, 2]);
    const ally = addNpc(f.state, f.rng, "Odalys", "ally", 3, 3);
    expect(aggroCheck(ally.state)!.participants).toContain(ally.id);
  });
  it("is deterministic and does not touch the state", () => {
    const f = withEnemy([8, 2]);
    const before = JSON.stringify(f.state);
    expect(aggroCheck(f.state)).toEqual(aggroCheck(f.state));
    expect(JSON.stringify(f.state)).toBe(before);
  });
});

describe("followStep", () => {
  it("brings a far ally closer by a bounded step", () => {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 18, 18);
    const s = placeAt(a.state, a.id, 18, 18);
    const party = Object.values(s.entities).filter((e) => e.kind === "pc");
    const nearest = (st: GameState) => Math.min(...party.map((p) => dist(st.entities[a.id]!, st.entities[p.id]!)));
    const r = followStep(s, w.rng);
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.type === "moved" && e.entityId === a.id)).toBe(true);
    const moved = dist(s.entities[a.id]!, r.state.entities[a.id]!);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(6);
    expect(nearest(r.state)).toBeLessThan(nearest(s));
    expect(r.state.npcs[a.id]).toMatchObject({ x: r.state.entities[a.id]!.x, y: r.state.entities[a.id]!.y });
  });
  it("leaves an ally that is already close", () => {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 6, 6);
    const near = placeAt(a.state, "ch_brindle", 5, 5);
    const r = followStep(near, w.rng);
    expect(r.events).toEqual([]);
    expect(r.state.entities[a.id]).toMatchObject({ x: 6, y: 6 });
  });
  it("repeated steps end within the stop distance, on a free tile", () => {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 19, 19);
    let s = a.state;
    for (let i = 0; i < 6; i++) s = followStep(s, w.rng).state;
    const e = s.entities[a.id]!;
    const near = Math.min(...PARTY_IDS.map((id) => dist(e, s.entities[id]!)));
    expect(near).toBeLessThanOrEqual(2);
    expect(PARTY_IDS.every((id) => s.entities[id]!.x !== e.x || s.entities[id]!.y !== e.y)).toBe(true);
  });
  it("does not move bystanders, villains or hostile creatures", () => {
    const w = makeWorld(7);
    const b = addNpc(w.state, w.rng, "Bo", "bystander", 18, 18);
    const v = addNpc(b.state, w.rng, "Pell", "villain", 18, 16);
    const r = followStep(v.state, w.rng);
    expect(r.events).toEqual([]);
  });
  it("does not walk through a closed door", () => {
    const wall: [number, number][] = [];
    for (let y = 0; y < 20; y++) if (y !== 10) wall.push([10, y]);
    const w = makeWorld(7, { walls: wall, objects: [door("d1", 10, 10, "closed")] });
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 18, 10);
    const r = followStep(a.state, w.rng);
    expect(r.events).toEqual([]);
    const open = withState(a.state, (s) => { s.interactables["m_lighthouse/d1"] = { state: "open" } as never; });
    const r2 = followStep(open, w.rng);
    expect(r2.events.length).toBeGreaterThan(0);
  });
  it("never lands on an occupied tile", () => {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 8, 2);
    const b = addNpc(a.state, w.rng, "Edda", "ally", 7, 2);
    let s = placeAt(placeAt(placeAt(b.state, "ch_brindle", 2, 2), "ch_tamsin", 2, 3), "ch_orrin", 3, 2);
    for (let i = 0; i < 4; i++) s = followStep(s, w.rng).state;
    const seen = new Set(Object.values(s.entities).map((e) => `${e.x},${e.y}`));
    expect(seen.size).toBe(Object.keys(s.entities).length);
  });
  it("does nothing during combat", () => {
    const f = withEnemy([8, 2]);
    const ally = addNpc(f.state, f.rng, "Odalys", "ally", 18, 18);
    const fought = startCombat(ally.state, f.rng, [...aggroCheck(ally.state)!.participants.filter((p) => p !== ally.id)], "standard");
    const r = followStep(fought.state, f.rng);
    expect(r.ok).toBe(false);
    expect(r.state.entities[ally.id]).toMatchObject({ x: 18, y: 18 });
  });
  it("is deterministic", () => {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 18, 18);
    expect(followStep(a.state, w.rng).events).toEqual(followStep(a.state, w.rng).events);
  });
});

describe("calm creatures", () => {
  function fought(reason: "truce" | "flee" | "defeat" | "victory") {
    const f = withEnemy([8, 2]);
    const started = startCombat(f.state, f.rng, aggroCheck(f.state)!.participants, "standard");
    const ended = endCombat(started.state, f.rng, reason);
    return { ...f, ended: ended.state };
  }
  it.each(["truce", "flee", "defeat"] as const)("a surviving enemy is calm after a %s and does not pull the party back in", (reason) => {
    const f = fought(reason);
    expect(f.ended.entities[f.enemyId]!.calm).toBe(true);
    expect(aggroCheck(f.ended)).toBeNull();
  });
  it("a calm creature neither notices the party nor joins when another creature notices", () => {
    const w = makeWorld(7);
    const a = withArchetype(w.state);
    let s = spawn(a.state, w.rng, a.id, 8, 2);
    s = spawn(s, w.rng, a.id, 8, 3);
    s = placeAt(placeAt(placeAt(s, "ch_brindle", 2, 2), "ch_tamsin", 2, 3), "ch_orrin", 3, 2);
    const [first, second] = Object.values(s.entities).filter((e) => e.kind === "enemy").map((e) => e.id);
    const calmed = withState(s, (x) => { x.entities[first!]!.calm = true; });
    const r = aggroCheck(calmed)!;
    expect(r.enemyIds).toEqual([second]);
    expect(r.participants).not.toContain(first);
  });
  it("starting a new combat clears the flag on its participants", () => {
    const f = fought("truce");
    const bystander = withState(f.ended, (x) => { x.entities[f.enemyId]!.calm = true; });
    const r = startCombat(bystander, f.rng, [...PARTY_IDS, f.enemyId], "standard");
    expect(r.ok).toBe(true);
    expect(r.state.entities[f.enemyId]!.calm).toBeUndefined();
  });
  it("the flag survives a save round trip", () => {
    const f = fought("truce");
    const back = JSON.parse(JSON.stringify(f.ended)) as GameState;
    expect(aggroCheck(back)).toBeNull();
    expect(back.entities[f.enemyId]!.calm).toBe(true);
  });
});

describe("allies at a scene change", () => {
  function twoMaps() {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 5, 5);
    const far = addNpc(a.state, w.rng, "Edda", "ally", 18, 18);
    const map2 = makeTestMap("m_cellar");
    return { ...w, state: addMap(far.state, map2).state, near: a.id, far: far.id };
  }
  it("picks the allies within follow distance of the party", () => {
    const t = twoMaps();
    const s = placeAt(placeAt(placeAt(t.state, "ch_brindle", 4, 4), "ch_tamsin", 4, 5), "ch_orrin", 5, 4);
    expect(alliesWithParty(s, PARTY_IDS)).toEqual([t.near]);
  });
  it("moves them next to the new entry, and keeps the NPC record in step", () => {
    const t = twoMaps();
    let s = placeAt(placeAt(placeAt(t.state, "ch_brindle", 4, 4), "ch_tamsin", 4, 5), "ch_orrin", 5, 4);
    const ids = alliesWithParty(s, PARTY_IDS);
    const m: Mut = { s: cloneState(s), rng: t.rng, ev: [] };
    s = placePartyOnMap(m.s, "m_cellar").state;
    m.s = s;
    expect(moveAlliesToScene(m, ids, "m_cellar", "party_start")).toBe(1);
    const e = m.s.entities[t.near]!;
    expect(e.mapId).toBe("m_cellar");
    expect(m.s.npcs[t.near]).toMatchObject({ map_id: "m_cellar", x: e.x, y: e.y });
    expect(m.s.entities[t.far]!.mapId).toBe("m_lighthouse");
    const taken = Object.values(m.s.entities).filter((x) => x.mapId === "m_cellar").map((x) => `${x.x},${x.y}`);
    expect(new Set(taken).size).toBe(taken.length);
    expect(m.ev.some((x) => x.type === "moved" && x.entityId === t.near && x.reason === "scene")).toBe(true);
  });
});

describe("allies and the change_scene action", () => {
  function setup() {
    const w = makeWorld(7);
    const a = addNpc(w.state, w.rng, "Odalys", "ally", 5, 5);
    const far = addNpc(a.state, w.rng, "Edda", "ally", 18, 18);
    const s = placeAt(placeAt(placeAt(addMap(far.state, makeTestMap("m_cellar")).state, "ch_brindle", 4, 4), "ch_tamsin", 4, 5), "ch_orrin", 5, 4);
    return { ...w, state: s, near: a.id, far: far.id };
  }
  it("a nearby ally comes along, a distant one stays, and the tiles are all distinct", () => {
    const t = setup();
    const r = applyDmActions(t.state, t.rng, [{ type: "change_scene", map_id: "m_cellar", entry: "party_start" }], CTX);
    expect(r.applied).toHaveLength(1);
    expect(r.state.entities[t.near]!.mapId).toBe("m_cellar");
    expect(r.state.npcs[t.near]).toMatchObject({ map_id: "m_cellar" });
    expect(r.state.entities[t.far]!.mapId).toBe("m_lighthouse");
    const taken = Object.values(r.state.entities).filter((x) => x.mapId === "m_cellar").map((x) => `${x.x},${x.y}`);
    expect(taken).toHaveLength(4);
    expect(new Set(taken).size).toBe(4);
  });
  it("a refused scene change moves nobody", () => {
    const t = setup();
    const r = applyDmActions(t.state, t.rng, [{ type: "change_scene", map_id: "m_cellar", entry: "no_such_spawn" }], CTX);
    expect(r.rejected).toHaveLength(1);
    expect(r.state.entities[t.near]!.mapId).toBe("m_lighthouse");
    expect(r.state.entities[t.near]).toMatchObject({ x: 5, y: 5 });
  });
  it("placePartyWithAllies does the same for a server-side move", () => {
    const t = setup();
    const r = placePartyWithAllies(t.state, "m_cellar", "party_start", PARTY_IDS);
    expect(r.value).toBe(true);
    expect(r.state.currentMapId).toBe("m_cellar");
    expect(r.state.entities[t.near]!.mapId).toBe("m_cellar");
    expect(r.state.entities[t.far]!.mapId).toBe("m_lighthouse");
    expect(r.events.some((e) => e.type === "moved" && e.entityId === t.near && e.reason === "scene")).toBe(true);
    expect(placePartyWithAllies(t.state, "m_cellar", "no_such_spawn", PARTY_IDS).value).toBe(false);
  });
});

describe("ally NPCs in a fight", () => {
  it("an allied NPC takes its turn through the same AI and attacks the enemy", () => {
    const f = withEnemy([4, 2]);
    const ally = addNpc(f.state, f.rng, "Odalys", "ally", 3, 3);
    const started = startCombat(ally.state, f.rng, [...PARTY_IDS, ally.id, f.enemyId], "standard");
    expect(started.ok).toBe(true);
    const s = cloneState(started.state);
    const c = s.combat!;
    c.cursor = c.order.findIndex((o) => o.entity_id === ally.id);
    c.active_id = ally.id;
    c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
    const r = enemyTakeTurn(s, f.rng, ally.id);
    expect(r.events.some((e) => e.type === "damage" || e.type === "attack_missed")).toBe(true);
    expect(chorister.name).toBeTruthy();
  });
});
