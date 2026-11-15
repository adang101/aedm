import { afterEach, describe, expect, it } from "vitest";
import { disarm, effectiveState, findInteractableAny, isHidden, performAct, rngFromState, type GameState } from "@aedm/engine";
import { scriptedProvider, sleep, startedTable, startHarness, type Harness } from "./helpers";
import { gameOf, obj, rig, stageRun, stateOf, trapObj, wire, type Stage } from "./stage";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  expect(cond()).toBe(true);
}

const dms = (p: { dmRequests(): unknown[] }) => p.dmRequests().length;
const hiddenAt = (st: GameState, s: Stage, id: string) => isHidden(st, s.mapId, findInteractableAny(st, s.mapId, id)!);

/** A hidden trap (DC 5) and a hidden chest with a container, two and three tiles from the first character. */
const stage = (t: Parameters<typeof stageRun>[1], harness: Harness): Stage => stageRun(harness, t, {
  objects: (g) => [
    trapObj("trap_h", g.x0 + 2, g.y, { hidden: true, trap: { dc: 5, dice: "1d6", damage_type: "sharp" } }),
    obj({ id: "chest_h", kind: "chest", state: "closed", hidden: true, x: g.x0 + 3, y: g.y }),
  ],
  edit: (st, g) => {
    st.containers.cn_h = { v: 1, id: "cn_h", kind: "chest", map_id: g.mapId, x: g.x0 + 3, y: g.y, label: "Chest", object_id: "chest_h", items: [{ id: "it_h", name: "Hidden coin", kind: "trinket", value: 1 }] };
  },
});

const finds = (actor: string, want: boolean) => (copy: GameState) => {
  const r = performAct(copy, rngFromState(copy), actor, "search");
  const ev = r.events.find((e) => e.type === "searched");
  return !!ev && ev.type === "searched" && (ev.found.length > 0) === want;
};

describe("search", () => {
  it("a search that finds things reveals them to everyone, shows the engine's words and costs no model call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stage(t, h);
    await gameOf(h).idle();
    const before = dms(provider);
    rig(h, finds(s.a, true));
    const ma = t.a.mark();
    const mb = t.b.mark();
    expect((await t.a.request("act", { verb: "search" })).type).not.toBe("error");
    const diff = await t.b.wait("state_diff", (p) => p.interactables_revealed !== undefined, { from: mb });
    const revealed = diff.payload.interactables_revealed!;
    expect(revealed.map((r) => r.object.id).sort()).toEqual(["chest_h", "trap_h"]);
    expect(revealed.every((r) => r.object.state === "closed" && r.map_id === s.mapId)).toBe(true);
    expect(JSON.stringify(revealed)).not.toMatch(/"hidden"|"trap":|"dc"/);
    expect((diff.payload.containers_changed ?? []).map((c) => c.id)).toEqual(["cn_h"]);
    const log = await t.a.wait("log", (p) => p.kind === "engine" && /searches and finds a trap, a chest/.test(p.text), { from: ma });
    expect(log.payload.text).not.toMatch(/\d/); // no roll total, DC or coordinates
    expect(t.a.all("roll_result", ma)).toHaveLength(0);
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/searches and finds a trap at \(\d+,\d+\), a chest at \(\d+,\d+\)/);
    expect(hiddenAt(stateOf(h), s, "trap_h")).toBe(false);
    expect(dms(provider)).toBe(before);
    expect(t.a.invalid).toEqual([]);
    expect(t.b.invalid).toEqual([]);
  });

  it("a search that finds nothing, and a repeat with nothing left to roll against, read the same and reveal nothing", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stage(t, h);
    await gameOf(h).idle();
    rig(h, finds(s.a, false));
    const ma = t.a.mark();
    expect((await t.a.request("act", { verb: "search" })).type).not.toBe("error");
    const first = await t.a.wait("log", (p) => p.kind === "engine" && /searches carefully but finds nothing new/.test(p.text), { from: ma });
    const m2 = t.a.mark();
    expect((await t.a.request("act", { verb: "search" })).type).not.toBe("error"); // the same character cannot try these again
    const second = await t.a.wait("log", (p) => p.kind === "engine" && /searches carefully but finds nothing new/.test(p.text), { from: m2 });
    expect(second.payload.text).toBe(first.payload.text);
    expect(hiddenAt(stateOf(h), s, "trap_h")).toBe(true);
    expect(hiddenAt(stateOf(h), s, "chest_h")).toBe(true);
    for (const c of [t.a, t.b]) {
      const all = wire(c, 0);
      expect(all).not.toContain("trap_h");
      expect(all).not.toContain("chest_h");
      expect(all).not.toContain("cn_h");
      expect(all).not.toContain("Hidden coin");
      expect(c.all("roll_result")).toHaveLength(0);
    }
  });

  it("search takes no target and a target is a malformed message", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    stage(t, h);
    expect((await t.a.request("act", { verb: "search", target_id: "trap_h" })).type).toBe("error");
    expect((await t.a.request("act", { verb: "open" })).type).toBe("error");
  });

  it("typed 'search the room' goes to the engine, not the DM", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stage(t, h);
    await gameOf(h).idle();
    const before = dms(provider);
    rig(h, finds(s.a, true));
    const ma = t.a.mark();
    t.a.send("say", { text: "search the room", channel: "ic" });
    await until(() => !hiddenAt(stateOf(h!), s, "trap_h"));
    await t.a.wait("log", (p) => /searches and finds/.test(p.text), { from: ma });
    await gameOf(h).idle();
    await sleep(120);
    expect(dms(provider)).toBe(before);
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/searches and finds/);
  });
});

describe("disarm", () => {
  const trapNear = (t: Parameters<typeof stageRun>[1], harness: Harness) => stageRun(harness, t, { objects: (g) => [trapObj("trap_d", g.x0 + 1, g.y, { trap: { dc: 5, dice: "1d6", damage_type: "sharp" } })] });
  const disarms = (actor: string, want: boolean) => (copy: GameState) => {
    const r = disarm(copy, rngFromState(copy), actor, "trap_d");
    return r.events.some((e) => e.type === "trap_disarmed") === want;
  };

  it("disarming a known trap makes it harmless for everyone, with no model call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = trapNear(t, h);
    await gameOf(h).idle();
    const before = dms(provider);
    rig(h, disarms(s.a, true));
    const mb = t.b.mark();
    const ma = t.a.mark();
    expect((await t.a.request("act", { verb: "disarm", target_id: "trap_d" })).type).not.toBe("error");
    const diff = await t.b.wait("state_diff", (p) => p.interactables_changed !== undefined, { from: mb });
    expect(diff.payload.interactables_changed).toEqual([{ map_id: s.mapId, id: "trap_d", state: "open" }]);
    await t.a.wait("log", (p) => p.kind === "engine" && /disarms the trap/.test(p.text), { from: ma });
    expect(effectiveState(stateOf(h), s.mapId, findInteractableAny(stateOf(h), s.mapId, "trap_d")!)).toBe("open");
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/disarms the trap/);
    expect(dms(provider)).toBe(before);
  });

  it("a typed 'disarm the trap' goes to the engine; a failure is told to the table and the trap stays armed", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = trapNear(t, h);
    await gameOf(h).idle();
    const before = dms(provider);
    // a failure that does not spring it: the roll misses by less than the spring margin
    rig(h, (copy) => {
      const r = disarm(copy, rngFromState(copy), s.a, "trap_d");
      return r.events.some((e) => e.type === "disarm_failed");
    });
    const ma = t.a.mark();
    t.a.send("say", { text: "disarm the trap", channel: "ic" });
    await t.a.wait("log", (p) => /fumbles with the trap/.test(p.text), { from: ma });
    await gameOf(h).idle();
    expect(effectiveState(stateOf(h), s.mapId, findInteractableAny(stateOf(h), s.mapId, "trap_d")!)).toBe("closed");
    expect(dms(provider)).toBe(before);
  });
});
