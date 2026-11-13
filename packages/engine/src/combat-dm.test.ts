import { describe, expect, it } from "vitest";
import type { DmAction } from "@aedm/schemas";
import { combatOutcome, enemyTakeTurn, startCombat } from "./combat.ts";
import { RULES } from "./data.ts";
import { applyDmActions, combatRefusal, type DmContext } from "./dm-actions.ts";
import { createRng } from "./rng.ts";
import { cloneState, type GameState } from "./state.ts";
import { allyStats, standardEnemy } from "./threat.ts";
import { PARTY_IDS, makeWorld, spawn, withArchetype } from "./testkit.ts";

const CTX: DmContext = { presentCharacterIds: PARTY_IDS, partyLevel: 1 };
const apply = (state: GameState, actions: DmAction[], ctx: DmContext = CTX) => applyDmActions(state, createRng(3), actions, ctx);
const newNpc = (name: string, role: "ally" | "bystander", x: number, y: number): DmAction => ({
  type: "create_npc", name, concept: "A local.", role, map_id: "m_lighthouse", x, y, sprite_tags: ["coat"],
});

/** A fight: the party, one chorister at (7,6) and, optionally, an allied NPC at (6,6). */
function fight(withAlly: boolean) {
  const w = makeWorld();
  const a = withArchetype(w.state);
  let state = spawn(a.state, w.rng, a.id, 7, 6);
  if (withAlly) state = apply(state, [newNpc("Edda", "ally", 6, 6)]).state;
  const enemy = Object.values(state.entities).find((e) => e.kind === "enemy")!.id;
  const ally = Object.values(state.entities).find((e) => e.kind === "npc")?.id;
  const r = startCombat(state, w.rng, [...PARTY_IDS, enemy, ...(ally ? [ally] : [])], "standard");
  expect(r.ok).toBe(true);
  return { state: r.state, rng: w.rng, enemy, ally: ally! };
}

describe("npc_say for enemies", () => {
  it("lets a living enemy in the scene speak and refuses an absent or defeated one", () => {
    const { state, enemy } = fight(false);
    const ok = apply(state, [{ type: "npc_say", entity_id: enemy, text: "You will drown with the rest." }]);
    expect(ok.applied).toHaveLength(1);
    expect(ok.events[0]).toMatchObject({ type: "npc_said", entityId: enemy });
    const gone = apply(state, [{ type: "npc_say", entity_id: "ei_missing", text: "Hello." }]);
    expect(gone.rejected[0]!.reason).toMatch(/no creature/);
    const dead = cloneState(state);
    delete dead.entities[enemy];
    expect(apply(dead, [{ type: "npc_say", entity_id: enemy, text: "Still here." }]).rejected).toHaveLength(1);
  });
});

describe("combat-safe actions", () => {
  const refused: DmAction[] = [
    { type: "start_combat", participants: ["x", "y"], difficulty: "easy" },
    newNpc("Late Arrival", "bystander", 9, 9),
    { type: "spawn_entity", archetype_id: "en_x", map_id: "m_lighthouse", x: 9, y: 9, count: 1 },
    { type: "create_enemy", concept: "A thing.", role: "standard", setting_notes: "" },
    { type: "generate_map", brief: { setting: { name: "Cave", preset: "cave" } } as never },
    { type: "change_scene", map_id: "m_lighthouse", entry: "party_start" },
    { type: "grant_item", recipient: "ch_orrin", item: { name: "Pearl", kind: "trinket", value: 1 } },
    { type: "award_growth", character_id: "ch_orrin", amount: 1, reason: "x" },
    { type: "complete_milestone", milestone_id: "ms_1" },
    { type: "adjust_plot", stages: [] },
  ];

  it("refuses every non-combat action mid-fight with a reason and leaves the state untouched", () => {
    const { state } = fight(false);
    for (const action of refused) {
      const r = apply(state, [action]);
      expect(r.applied, action.type).toHaveLength(0);
      expect(r.rejected[0]!.reason, action.type).toBe(`${action.type} is not allowed during combat`);
    }
  });

  it("allows the listed actions and applies them", () => {
    const { state, enemy } = fight(false);
    const r = apply(state, [
      { type: "npc_say", entity_id: enemy, text: "Back!" },
      { type: "set_fact", subject: "Edda", predicate: "free", object: "wary of the party" },
      { type: "open_thread", text: "Who sent the choir?" },
      { type: "suggest_actions", chips: ["Strike", "Parley"] },
      { type: "request_check", target: "ch_orrin", ability: "dex", dc: 12, tags: [], advantage: "none", reason: "kick the brazier" },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toHaveLength(5);
    expect(apply(state, [{ type: "end_combat", reason: "truce" }]).state.combat).toBeNull();
  });

  it("applies at most one condition per response, counting earlier ones", () => {
    const { state, enemy } = fight(false);
    const stun: DmAction = { type: "apply_condition", target: enemy, condition: "dazzled", turns: 1 };
    const two = apply(state, [stun, stun]);
    expect(two.applied).toHaveLength(1);
    expect(two.rejected[0]!.reason).toMatch(/one condition/);
    expect(apply(state, [stun], { ...CTX, conditionsApplied: RULES.npc.maxCombatConditions }).rejected).toHaveLength(1);
  });

  it("combatRefusal passes everything outside combat", () => {
    const { state } = makeWorld();
    for (const action of refused) expect(combatRefusal(state, action)).toBeUndefined();
  });
});

describe("allies", () => {
  it("an ally NPC gets the scaled stat block; other roles stay at 1 HP", () => {
    const w = makeWorld();
    const r = apply(w.state, [newNpc("Edda", "ally", 6, 6), newNpc("Pell", "bystander", 8, 8)]);
    const ent = (name: string) => Object.values(r.state.entities).find((e) => e.name === name)!;
    const stats = r.state.npcs[ent("Edda").id]!.stats!;
    expect(stats).toEqual(allyStats(1));
    expect(stats.hp).toBe(Math.round((standardEnemy(1).hp * RULES.npc.allyStatPct) / 100));
    expect(ent("Edda")).toMatchObject({ hp: stats.hp, hpMax: stats.hp });
    expect(ent("Pell")).toMatchObject({ hp: 1, hpMax: 1 });
    expect(r.state.npcs[ent("Pell").id]!.stats).toBeUndefined();
  });

  it("an ally acts on the party's side through enemyTakeTurn, attacking the enemy with its own block", () => {
    const f = fight(true);
    const s = cloneState(f.state);
    const c = s.combat!;
    c.cursor = c.order.findIndex((o) => o.entity_id === f.ally);
    c.active_id = f.ally;
    c.turn = { movementLeft: 6, actionUsed: false, quickUsed: false };
    const r = enemyTakeTurn(s, createRng(5), f.ally);
    expect(r.ok).toBe(true);
    const hit = r.events.find((e) => e.type === "damage" || e.type === "attack_missed");
    expect(hit).toMatchObject({ target: f.enemy });
    const roll = r.events.find((e) => e.type === "roll" && e.who === f.ally);
    expect(roll).toMatchObject({ modifier: allyStats(1).attack_bonus });
  });

  it("an ally standing keeps the fight going when every pc is down, and counts toward victory", () => {
    const f = fight(true);
    const s = cloneState(f.state);
    for (const id of PARTY_IDS) s.entities[id]!.hp = 0;
    expect(combatOutcome(s)).toBeNull();
    s.entities[f.ally]!.hp = 0;
    expect(combatOutcome(s)).toBe("defeat");
    s.entities[f.enemy]!.hp = 0;
    expect(combatOutcome(s)).toBe("victory");
  });
});
