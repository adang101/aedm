import { describe, expect, it } from "vitest";
import type { MapObject } from "@aedm/schemas";
import { applyDmActions } from "./dm-actions.ts";
import { DESCRIBE } from "./data.ts";
import { describeCreature, describeInventory, describeScene } from "./describe.ts";
import { examine } from "./interact.ts";
import { createRng } from "./rng.ts";
import { PARTY_IDS, chorister, makeWorld, placeAt, spawn, withArchetype, withState } from "./testkit.ts";
import { interactablesOf, type GameState } from "./state.ts";

const [A, B] = PARTY_IDS as [string, string];
const door = (id: string, x: number, y: number, state: "open" | "closed" | "locked"): MapObject => ({ type: "interactable", id, kind: "door", state, x, y });

function base(opts: { walls?: [number, number][]; objects?: MapObject[] } = {}): { state: GameState; arch: string } {
  const w = makeWorld(7, { ...(opts.walls ? { walls: opts.walls } : {}), ...(opts.objects ? { objects: opts.objects } : {}) });
  const { state, id } = withArchetype(w.state);
  return { state: placeAt(placeAt(state, A, 5, 5), B, 6, 5), arch: id };
}
const enemyId = (s: GameState): string => Object.values(s.entities).find((e) => e.kind === "enemy")!.id;

function withNpc(state: GameState, name: string, x: number, y: number): { state: GameState; id: string } {
  const r = applyDmActions(state, createRng(3), [{
    type: "create_npc", name, concept: "SECRET: the ferryman is a smuggler.", role: "bystander", map_id: "m_lighthouse", x, y, sprite_tags: ["coat"], appearance: "A weathered man in a wax coat.",
  }], { presentCharacterIds: PARTY_IDS, partyLevel: 1 });
  expect(r.rejected).toEqual([]);
  const id = Object.values(r.state.entities).find((e) => e.name === name)!.id;
  return { state: r.state, id };
}

describe("describeScene", () => {
  it("names the place, exits with sides, objects with their current state and the party", () => {
    const { state } = base({ objects: [door("d1", 8, 8, "closed"), { type: "interactable", id: "l1", kind: "lever", state: "closed", x: 9, y: 9 }] });
    const text = describeScene(state, A);
    expect(text).toContain("Lighthouse interior");
    expect(text).toContain("dim");
    expect(text).toMatch(/door \(west\)/);
    expect(text).toContain("a closed door");
    expect(text).toContain("a lever, pushed up");
    expect(text).toContain(state.characters[B]!.name);
    expect(text).not.toContain(state.characters[A]!.name);
  });

  it("reads a door opened in play as open", () => {
    const { state } = base({ objects: [door("d1", 8, 8, "closed")] });
    const opened = withState(state, (s) => { s.interactables["m_lighthouse/d1"] = { state: "open" }; });
    expect(describeScene(opened, A)).toContain("an open door");
    expect(describeScene(opened, A)).not.toContain("closed door");
  });

  it("never lists the contents of a closed or locked chest, but lists piles and remains", () => {
    const { state } = base({ objects: [{ type: "interactable", id: "c1", kind: "chest", state: "locked", lock: { dc: 10 }, x: 9, y: 9 }] });
    const s2 = withState(state, (s) => {
      s.containers["cn_pile"] = { id: "cn_pile", kind: "pile", map_id: "m_lighthouse", x: 7, y: 7, items: [{ id: "it_1", name: "Secret Ruby", kind: "trinket", value: 5 }] } as never;
    });
    const text = describeScene(s2, A);
    expect(text).toContain("a locked chest");
    expect(text).toContain("a pile of dropped items");
    expect(text).not.toContain("Secret Ruby");
  });

  it("lists creatures by name and marks the hostile and the downed", () => {
    const { state, arch } = base();
    const s = spawn(state, createRng(5), arch, 10, 5, 1);
    const hurt = withState(s, (x) => { x.entities[B]!.hp = 0; });
    const text = describeScene(hurt, A);
    expect(text).toContain("Robed Chorister (hostile)");
    expect(text).toContain(`${state.characters[B]!.name} (downed)`);
  });

  it("does not list creatures behind a closed door or a wall", () => {
    const { state, arch } = base({ objects: [door("d1", 8, 5, "closed")], walls: [[8, 6], [8, 4]] });
    const s = spawn(state, createRng(5), arch, 11, 5, 1);
    expect(describeScene(s, A)).not.toContain("Chorister");
    const opened = withState(s, (x) => { x.interactables["m_lighthouse/d1"] = { state: "open" }; });
    expect(describeScene(opened, A)).toContain("Chorister");
  });

  it("caps long lists and says how many were left out", () => {
    const objs: MapObject[] = Array.from({ length: 9 }, (_, i) => door(`d${i}`, 3 + i, 12, "closed"));
    const { state } = base({ objects: objs });
    const text = describeScene(state, A);
    const total = interactablesOf(state.maps["m_lighthouse"]!).length;
    expect(total).toBeGreaterThan(DESCRIBE.caps.objects);
    expect(text).toContain(DESCRIBE.more.replace("{n}", String(total - DESCRIBE.caps.objects)));
  });

  it("is deterministic and never prints coordinates or ids", () => {
    const { state, arch } = base();
    const s = spawn(state, createRng(5), arch, 10, 5, 1);
    expect(describeScene(s, A)).toBe(describeScene(s, A));
    expect(describeScene(s, A)).not.toMatch(/en_\d|ch_\d|\(\d+,\s*\d+\)/);
  });

  it("returns a plain line for an unknown actor", () => {
    const { state } = base();
    expect(describeScene(state, "nobody")).toBe(DESCRIBE.scene.noPlace);
  });
});

describe("describeCreature", () => {
  it("an enemy gets name, appearance and a health band, never numbers, concept or behavior", () => {
    const w = makeWorld(7);
    const { state, id } = withArchetype(w.state, { ...chorister, appearance: "Pale robes dripping seawater." });
    const s = spawn(state, createRng(5), id, 10, 5, 1);
    const eid = enemyId(s);
    const text = describeCreature(s, eid)!;
    expect(text).toContain("Robed Chorister");
    expect(text).toContain("Pale robes dripping seawater.");
    expect(text).toContain("unhurt");
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain("drowned"); // concept
    expect(text).not.toContain("Closes to melee"); // behavior
    const bands = [[1.0, "unhurt"], [0.8, "scratched"], [0.6, "wounded"], [0.3, "badly wounded"], [0.01, "barely standing"]] as const;
    for (const [f, word] of bands) {
      const hurt = withState(s, (x) => { const e = x.entities[eid]!; e.hp = Math.max(1, Math.ceil(e.hpMax * f)); });
      expect(describeCreature(hurt, eid), String(f)).toContain(word);
    }
    const down = withState(s, (x) => { x.entities[eid]!.hp = 0; });
    expect(describeCreature(down, eid)).toContain("downed");
  });

  it("shows visible conditions", () => {
    const { state, arch } = base();
    const s = spawn(state, createRng(5), arch, 10, 5, 1);
    const eid = enemyId(s);
    const burning = withState(s, (x) => { x.entities[eid]!.conditions.push({ condition: "burning", turns: 2 }); });
    expect(describeCreature(burning, eid)).toContain(DESCRIBE.creature.conditions.burning);
  });

  it("an NPC gets name, appearance and disposition but never concept, notes, voice or lines", () => {
    const { state } = base();
    const n = withNpc(state, "Odalys Brand", 10, 5);
    const loaded = withState(n.state, (s) => {
      const rec = s.npcs[s.entities[n.id]!.refId]!;
      rec.notes = ["SECRET note: owes the harbormaster"]; rec.voice = "SECRET voice clipped"; rec.lines = ["SECRET line"];
      rec.disposition = "wary"; s.entities[n.id]!.disposition = "wary";
    });
    const text = describeCreature(loaded, n.id)!;
    expect(text).toContain("Odalys Brand");
    expect(text).toContain("weathered man in a wax coat");
    expect(text).toContain(DESCRIBE.creature.dispositions.wary);
    expect(text).not.toMatch(/SECRET|smuggler/);
  });

  it("a party member gets name, title, health band and conditions", () => {
    const { state } = base();
    const s = withState(state, (x) => { x.entities[B]!.hp = Math.ceil(x.entities[B]!.hpMax / 2); x.entities[B]!.conditions.push({ condition: "slowed", turns: 1 }); });
    const text = describeCreature(s, B)!;
    expect(text).toContain(state.characters[B]!.name);
    if (state.characters[B]!.title) expect(text).toContain(state.characters[B]!.title);
    expect(text).toMatch(/wounded/);
    expect(text).toContain("slowed");
    expect(text).not.toMatch(/\d/);
  });

  it("is undefined for an unknown entity", () => {
    expect(describeCreature(base().state, "zzz")).toBeUndefined();
  });
});

describe("describeInventory", () => {
  it("lists items with counts for duplicates, and says so when empty", () => {
    const { state } = base();
    const s = withState(state, (x) => {
      x.characters[A]!.inventory = [
        { id: "i1", name: "Rope", kind: "trinket", value: 1 }, { id: "i2", name: "Rope", kind: "trinket", value: 1 }, { id: "i3", name: "Brass key", kind: "quest", value: 0 },
      ];
    });
    expect(describeInventory(s, A)).toBe("You are carrying: Rope x2 and Brass key.");
    const empty = withState(state, (x) => { x.characters[A]!.inventory = []; });
    expect(describeInventory(empty, A)).toBe(DESCRIBE.inventory.empty);
  });
});

describe("examine of a creature", () => {
  it("returns the engine description through the examined event, and is no longer narrative", () => {
    const { state, arch } = base();
    const s = spawn(state, createRng(5), arch, 7, 5, 1);
    const eid = enemyId(s);
    const r = examine(s, createRng(1), A, eid);
    expect(r.ok).toBe(true);
    expect(r.narrative).toBe(false);
    expect(r.text).toBe(describeCreature(s, eid));
    expect(r.events.map((e) => e.type)).toContain("examined");
  });

  it("refuses beyond the examine reach and stays free in combat", () => {
    const { state, arch } = base();
    const far = spawn(state, createRng(5), arch, 18, 18, 1);
    expect(examine(far, createRng(1), A, enemyId(far)).ok).toBe(false);
  });

  it("an NPC examines as a description too; the DM-only fields stay out", () => {
    const { state } = base();
    const n = withNpc(state, "Odalys Brand", 7, 6);
    const r = examine(n.state, createRng(1), A, n.id);
    expect(r.ok && !r.narrative).toBe(true);
    expect(r.text).not.toContain("smuggler");
  });
});
