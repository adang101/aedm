import { describe, expect, it } from "vitest";
import { startCombat, wakeIfWiped } from "./combat.ts";
import { createRng } from "./rng.ts";
import { PARTY_IDS, makeWorld, spawn, withArchetype, withState } from "./testkit.ts";

const [A, B] = PARTY_IDS as [string, string];
const down = (hp = 0) => (s: { entities: Record<string, { hp: number; conditions: unknown[] }> }, id: string) => { s.entities[id]!.hp = hp; s.entities[id]!.conditions = [{ condition: "prone", turns: 99 }]; };

describe("wakeIfWiped", () => {
  it("does nothing while someone still stands", () => {
    const w = makeWorld(3, {});
    const s = withState(w.state, (st) => down()(st as never, A));
    const r = wakeIfWiped(s, createRng(1));
    expect(r.ok).toBe(true);
    expect(r.events).toEqual([]);
    expect(r.state.entities[A]!.hp).toBe(0);
  });
  it("wakes every downed hero at the data wake HP when none is left standing, outside combat", () => {
    const w = makeWorld(3, {});
    const s = withState(w.state, (st) => { for (const id of PARTY_IDS) down()(st as never, id); });
    const r = wakeIfWiped(s, createRng(1));
    expect(r.events.map((e) => e.type)).toEqual(PARTY_IDS.map(() => "woke"));
    for (const id of PARTY_IDS) {
      expect(r.state.entities[id]!.hp).toBe(1);
      expect(r.state.entities[id]!.conditions.some((c) => c.condition === "prone")).toBe(false);
    }
    expect(s.entities[A]!.hp).toBe(0); // the input is untouched
  });
  it("leaves a fight alone", () => {
    const w = makeWorld(3, {});
    const a = withArchetype(w.state);
    const s = spawn(a.state, createRng(4), a.id, 10, 10);
    const c = startCombat(s, createRng(2), [A, B, ...Object.keys(s.entities).filter((id) => s.entities[id]!.kind === "enemy")], "standard");
    expect(c.ok).toBe(true);
    const d = withState(c.state, (st) => { for (const id of PARTY_IDS) down()(st as never, id); });
    expect(wakeIfWiped(d, createRng(1)).events).toEqual([]);
  });
});
