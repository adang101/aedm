import { afterEach, describe, expect, it } from "vitest";
import { altarUsedBy } from "@aedm/engine";
import { scriptedProvider, sleep, startedTable, startHarness, type Harness } from "./helpers";
import { gameOf, obj, stageRun, stateOf } from "./stage";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const dms = (p: { dmRequests(): unknown[] }) => p.dmRequests().length;

describe("altars", () => {
  it("using an altar gives the boon from the engine, shows its words, tells the DM and makes no model call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, {
      objects: (g) => [obj({ id: "altar_m", kind: "altar", state: "closed", x: g.x0 + 1, y: g.y, altar: { boon: "mend" } })],
      edit: (st, g) => { st.entities[g.a]!.hp = 4; },
    });
    await gameOf(h).idle();
    const before = dms(provider);
    const ma = t.a.mark();
    expect((await t.a.request("act", { verb: "interact", target_id: "altar_m" })).type).not.toBe("error");
    const line = await t.a.wait("log", (p) => p.kind === "engine" && /kneels at the altar, and their wounds ease/.test(p.text), { from: ma });
    expect(line.payload.text).toContain("Brindle");
    expect(stateOf(h).entities[s.a]!.hp).toBeGreaterThan(4);
    expect(altarUsedBy(stateOf(h), s.mapId, "altar_m", s.a)).toBe(true);
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/takes the boon of altar altar_m: mend/);
    await sleep(150);
    expect(dms(provider)).toBe(before);
    expect(t.a.invalid).toEqual([]);
  });

  it("a second try is silent: ok, one line, no change; and the other character can still use it", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [obj({ id: "altar_m", kind: "altar", state: "closed", x: g.x0 + 1, y: g.y, altar: { boon: "ward" } })] });
    expect((await t.a.request("act", { verb: "interact", target_id: "altar_m" })).type).not.toBe("error");
    const hp = stateOf(h).entities[s.a]!.hp;
    const ma = t.a.mark();
    expect((await t.a.request("act", { verb: "interact", target_id: "altar_m" })).type).not.toBe("error");
    await t.a.wait("log", (p) => /The altar is silent; it has nothing more for Brindle/.test(p.text), { from: ma });
    expect(stateOf(h).entities[s.a]!.hp).toBe(hp);
    const mb = t.b.mark();
    expect((await t.b.request("act", { verb: "interact", target_id: "altar_m" })).type).not.toBe("error");
    await t.b.wait("log", (p) => /touches the altar, and a faint ward settles over them/.test(p.text), { from: mb });
  });

  it("typed 'pray at the altar' goes to the engine", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [obj({ id: "altar_m", kind: "altar", state: "closed", x: g.x0 + 1, y: g.y, altar: { boon: "cleanse" } })] });
    await gameOf(h).idle();
    const before = dms(provider);
    const ma = t.a.mark();
    t.a.send("say", { text: "pray at the altar", channel: "ic" });
    await t.a.wait("log", (p) => /rests a hand on the altar, and every ill leaves them/.test(p.text), { from: ma });
    await gameOf(h).idle();
    expect(altarUsedBy(stateOf(h), s.mapId, "altar_m", s.a)).toBe(true);
    expect(dms(provider)).toBe(before);
  });
});
