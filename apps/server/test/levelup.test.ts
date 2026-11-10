import { afterEach, describe, expect, it } from "vitest";
import { abilityCost, levelCaps, type GameState } from "@aedm/engine";
import type { EntityView } from "@aedm/schemas";
import { brindle, dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type Table, type TestClient } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const stateOf = (harness: Harness): GameState => harness.server.rooms.all()[0]!.game!.state;
const say = (c: TestClient, text: string, channel: "ic" | "ooc" = "ic") => c.send("say", { text, channel });

async function beat(t: Table): Promise<number> {
  const mark = t.a.mark();
  say(t.a, "I look around.");
  say(t.b, "I look too.");
  return mark;
}

async function milestone(t: Table, id: string): Promise<void> {
  const provider = h!.provider as ReturnType<typeof scriptedProvider>;
  provider.queueDm(dmReply([{ type: "complete_milestone", milestone_id: id }]));
  const from = t.a.mark();
  await beat(t);
  await t.a.wait("level_up_state", () => true, { from });
}

const lastLevelUp = (c: TestClient) => c.all("level_up_state").at(-1)!.payload;

describe("level-up flow", () => {
  it("milestone -> level_up_state to the owner only -> score and ability choices update the character", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    await milestone(t, "m1");
    await t.b.wait("level_up_state", () => true);
    const a1 = lastLevelUp(t.a);
    expect(a1).toMatchObject({ level: 2, score_points: 0, ability_picks: 1, budget: levelCaps(2).budget });
    expect(a1.budget_used).toBe(a1.abilities.reduce((n, a) => n + abilityCost(a), 0));
    // every level_up_state a client got is about its own character
    expect(new Set(t.a.all("level_up_state").map((m) => m.payload.character_id)).size).toBe(1);
    expect(t.a.all("level_up_state")[0]!.payload.character_id).not.toBe(t.b.all("level_up_state")[0]!.payload.character_id);

    await milestone(t, "m2");
    const a2 = lastLevelUp(t.a);
    expect(a2).toMatchObject({ level: 3, score_points: 1, ability_picks: 2 });
    const chId = a2.character_id;

    // score point
    const mark = t.a.mark();
    const con = a2.scores.con;
    const r1 = await t.a.request("level_up_choice", { kind: "score", ability: "con" });
    expect(r1.type).toBe("level_up_result");
    if (r1.type === "level_up_result") expect(r1.payload.ok).toBe(true);
    const st1 = await t.a.wait("level_up_state", (p) => p.score_points === 0, { from: mark });
    expect(st1.payload.scores.con).toBe(con + 1);
    expect(stateOf(h).characters[chId]!.scores.con).toBe(con + 1);

    // second score point is refused
    const again = await t.a.request("level_up_choice", { kind: "score", ability: "str" });
    expect(again.type).toBe("error");

    // new ability through the fake forge
    const mark2 = t.a.mark();
    const r2 = await t.a.request("level_up_choice", { kind: "new_ability", text: "Chain Spark: lightning arcs from one enemy to another nearby, shocking both." });
    expect(r2.type).toBe("level_up_result");
    if (r2.type !== "level_up_result") return;
    expect(r2.payload.ok, r2.payload.message).toBe(true);
    expect(r2.payload.ability?.id).toMatch(/^ab_/);
    const st2 = await t.a.wait("level_up_state", (p) => p.ability_picks === 1, { from: mark2 });
    expect(st2.payload.abilities).toHaveLength(4);
    expect(st2.payload.budget_used).toBeLessThanOrEqual(st2.payload.budget);
    const log = await t.b.waitMsg((m) => m.type === "log" && /learned/.test(m.payload.text));
    expect(log.type).toBe("log");
    expect(stateOf(h).characters[chId]!.abilities).toHaveLength(4);

    // skip the last pick: the screen closes (zero picks)
    const mark3 = t.a.mark();
    await t.a.request("level_up_choice", { kind: "skip_ability" });
    const closed = await t.a.wait("level_up_state", (p) => p.ability_picks === 0 && p.score_points === 0, { from: mark3 });
    expect(closed.payload.abilities).toHaveLength(4);
    expect(stateOf(h).pendingLevelUps[chId]).toBeUndefined();
    expect([t.a, t.b].flatMap((c) => c.invalid)).toEqual([]);
  });

  it("reforge replaces an ability and frees its cost", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    await milestone(t, "m1");
    const st = lastLevelUp(t.a);
    const target = st.abilities[0]!;
    const r = await t.a.request("level_up_choice", { kind: "reforge", ability_id: target.id, text: "Fog Lantern: a lantern that reveals hidden things nearby." });
    expect(r.type).toBe("level_up_result");
    if (r.type !== "level_up_result") return;
    expect(r.payload.ok, r.payload.message).toBe(true);
    const abs = stateOf(h).characters[st.character_id]!.abilities;
    expect(abs).toHaveLength(3);
    expect(abs.some((a) => a.id === target.id)).toBe(false);
    const bad = await t.a.request("level_up_choice", { kind: "reforge", ability_id: "ab_nope", text: "anything" });
    expect(bad.type).toBe("error");
  });

  it("refuses choices during combat, with nothing pending, and cannot touch another player's character", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    // nothing pending yet
    const none = await t.a.request("level_up_choice", { kind: "skip_ability" });
    expect(none.type).toBe("error");

    await milestone(t, "m1");
    const snap = t.a.lastSnapshot()!;
    const [p1, p2] = snap.entities.filter((e) => e.kind === "pc") as [EntityView, EntityView];
    provider.queueDm(dmReply([
      { type: "create_enemy", concept: "A hollow-eyed marsh brute", role: "standard", setting_notes: "", ref: "en_marsh_brute" },
      { type: "spawn_entity", archetype_id: "en_marsh_brute", map_id: snap.map.id, x: p1.x + 1, y: p1.y + 1, count: 1 },
      { type: "start_combat", participants: [p1.id, p2.id, "en_marsh_brute"], difficulty: "standard" },
    ]));
    const mark = t.a.mark();
    await beat(t);
    await t.a.wait("combat_state", () => true, { from: mark });
    const r = await t.a.request("level_up_choice", { kind: "new_ability", text: "Spark" });
    expect(r.type).toBe("error");
    if (r.type === "error") expect(r.payload.message).toMatch(/finish the fight first/i);
    expect(stateOf(h).characters[lastLevelUp(t.a).character_id]!.abilities).toHaveLength(3);

    // b has its own pending pick; its choice never changes a's character
    const aChar = lastLevelUp(t.a).character_id;
    // Compare only level-up fields: combat is live, so enemy turns may change HP meanwhile.
    const growth = () => {
      const c = stateOf(h).characters[aChar]!;
      return JSON.stringify({ level: c.level, abilities: c.abilities, scores: c.scores });
    };
    const before = growth();
    await t.b.request("level_up_choice", { kind: "skip_ability" });
    expect(growth()).toBe(before);
  });

  it("re-sends the pending level_up_state on reconnect", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    await milestone(t, "m1");
    const a2 = await h.connect();
    const mark = a2.mark();
    await a2.join(t.code, "Alice", t.a.token);
    const st = await a2.wait("level_up_state", () => true, { from: mark });
    expect(st.payload.ability_picks).toBe(1);
    await sleep(10);
  });
});

describe("/dev grow", () => {
  async function solo(devSolo: boolean) {
    h = await startHarness({ provider: scriptedProvider() });
    const a = await h.connect();
    await a.createAndJoin("Solo");
    await a.request("claim_character", { character_id: "new", character: brindle() });
    if (devSolo) await a.request("update_settings", { dev_solo: true });
    else await a.request("update_settings", { dev_solo: false });
    return a;
  }

  it("grants growth and level-up choices when dev_solo is on", async () => {
    const a = await solo(true);
    const mark = a.mark();
    await a.request("start_game", {});
    await a.wait("state_snapshot", () => true, { from: mark });
    say(a, "/dev grow 100", "ooc");
    const st = await a.wait("level_up_state", () => true);
    expect(st.payload).toMatchObject({ level: 2, ability_picks: 1 });
    expect(a.all("chat").some((m) => m.payload.text.startsWith("/dev"))).toBe(false);
  });

  it("is impossible when dev_solo is off", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const before = JSON.stringify(Object.values(stateOf(h).characters).map((c) => c.growth));
    const mark = t.a.mark();
    say(t.a, "/dev grow 500", "ooc");
    await t.a.waitMsg((m) => m.type === "log" && /disabled/i.test(m.payload.text), { from: mark });
    await sleep(80);
    expect(JSON.stringify(Object.values(stateOf(h).characters).map((c) => c.growth))).toBe(before);
    expect(t.a.all("level_up_state", mark)).toHaveLength(0);
    expect(t.b.all("chat").some((m) => m.payload.text.includes("/dev"))).toBe(false);
  });
});
