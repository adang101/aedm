import { describe, expect, it } from "vitest";
import { planEngagement } from "./engage.ts";
import { startCombat } from "./combat.ts";
import { computePartyLevel } from "./dm-actions.ts";
import { chorister, makeWorld, PARTY_IDS, spawn, withArchetype, withState } from "./testkit.ts";

function world(count = 2) {
  const w = makeWorld(11);
  const reg = withArchetype(w.state);
  const state = spawn(reg.state, w.rng, reg.id, 8, 8, count);
  const enemies = Object.values(state.entities).filter((e) => e.kind === "enemy");
  return { state, rng: w.rng, enemies };
}
const ctx = (state: ReturnType<typeof world>["state"]) => ({ presentCharacterIds: PARTY_IDS, partyLevel: computePartyLevel(state, PARTY_IDS) });

describe("planEngagement", () => {
  it("joins every party character and every living hostile enemy on the map", () => {
    const { state, enemies } = world(2);
    const p = planEngagement(state, PARTY_IDS[0]!, enemies[0]!.id, ctx(state));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect([...p.participants].sort()).toEqual([...PARTY_IDS, ...enemies.map((e) => e.id)].sort());
    expect(p.foes).toHaveLength(2);
    expect(p.starter).toBeTruthy();
    expect(["standard", "hard", "deadly"]).toContain(p.difficulty);
  });
  it("produces a plan startCombat accepts", () => {
    const { state, rng, enemies } = world(2);
    const p = planEngagement(state, PARTY_IDS[0]!, enemies[0]!.id, ctx(state));
    if (!p.ok) throw new Error(p.reason);
    expect(startCombat(state, rng, p.participants, p.difficulty).ok).toBe(true);
  });
  it("skips a dead enemy and party members who are not present", () => {
    const { state, enemies } = world(2);
    const s = withState(state, (x) => { x.entities[enemies[1]!.id]!.hp = 0; });
    const p = planEngagement(s, PARTY_IDS[0]!, enemies[0]!.id, { ...ctx(s), presentCharacterIds: [PARTY_IDS[0]!] });
    if (!p.ok) throw new Error(p.reason);
    expect(p.participants).toEqual([PARTY_IDS[0], enemies[0]!.id]);
  });
  it("joins a living allied NPC on the map", () => {
    const { state, enemies } = world(1);
    const s = withState(state, (x) => {
      x.npcs["npc_edda"] = { id: "npc_edda", name: "Edda", concept: "ferrywoman", role: "ally", map_id: "m_lighthouse", x: 3, y: 3, sprite_tags: [], disposition: "friendly", alive: true, last_seen_beat: 0 } as never;
      x.entities["npc_edda"] = { ...Object.values(x.entities).find((e) => e.kind === "pc")!, id: "npc_edda", kind: "npc", name: "Edda", refId: "npc_edda", disposition: "friendly" };
    });
    const p = planEngagement(s, PARTY_IDS[0]!, enemies[0]!.id, ctx(s));
    if (!p.ok) throw new Error(p.reason);
    expect(p.participants).toContain("npc_edda");
  });
  it("refuses a missing target, a party member, an NPC, a corpse, another map and an active fight", () => {
    const { state, enemies } = world(1);
    const ok = (id: string, s = state) => planEngagement(s, PARTY_IDS[0]!, id, ctx(s));
    expect(ok("nope")).toMatchObject({ ok: false });
    expect(ok(PARTY_IDS[1]!)).toMatchObject({ ok: false });
    const npc = withState(state, (x) => { x.entities[enemies[0]!.id]!.kind = "npc"; });
    expect(ok(enemies[0]!.id, npc)).toMatchObject({ ok: false });
    const dead = withState(state, (x) => { x.entities[enemies[0]!.id]!.hp = 0; });
    expect(ok(enemies[0]!.id, dead)).toMatchObject({ ok: false });
    const away = withState(state, (x) => { x.entities[enemies[0]!.id]!.mapId = "m_elsewhere"; });
    expect(ok(enemies[0]!.id, away)).toMatchObject({ ok: false });
    const attackerGone = planEngagement(state, "ghost", enemies[0]!.id, ctx(state));
    expect(attackerGone).toMatchObject({ ok: false });
    const rng = makeWorld(1).rng;
    const fight = startCombat(state, rng, [...PARTY_IDS, enemies[0]!.id], "standard");
    if (!fight.ok) throw new Error(fight.error);
    expect(ok(enemies[0]!.id, fight.state)).toMatchObject({ ok: false });
  });
  it("raises the difficulty when the enemies' threat needs it", () => {
    const w = makeWorld(5);
    const reg = withArchetype(w.state, { ...chorister, stats: { ...chorister.stats, hp: 12 } });
    const state = withState(reg.state, (s) => { s.archetypes[reg.id]!.threat = 1000; });
    const placed = spawnRaw(state, reg.id);
    const p = planEngagement(placed.state, PARTY_IDS[0]!, placed.id, ctx(placed.state));
    if (!p.ok) throw new Error(p.reason);
    expect(p.difficulty).toBe("deadly");
  });
});

function spawnRaw(state: ReturnType<typeof world>["state"], archetypeId: string) {
  const w = makeWorld(5);
  const s = withState(state, (x) => {
    const base = Object.values(x.entities).find((e) => e.kind === "pc")!;
    x.entities["ei_big"] = { ...base, id: "ei_big", kind: "enemy", name: "Big", refId: archetypeId, disposition: "hostile", x: 9, y: 9 };
  });
  void w;
  return { state: s, id: "ei_big" };
}
