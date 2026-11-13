import { afterEach, describe, expect, it } from "vitest";
import { isWalkable, type Entity, type GameState } from "@aedm/engine";
import type { EntityView, GameMap } from "@aedm/schemas";
import { dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type Table, type TestClient } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const gameOf = (harness: Harness) => harness.server.rooms.all()[0]!.game!;
const stateOf = (harness: Harness): GameState => gameOf(harness).state;
const constantRandom = (v: number) => () => v;
const say = (c: TestClient, text: string) => c.send("say", { text, channel: "ic" });

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  expect(cond()).toBe(true);
}

/** A walkable, unoccupied step direction for each PC, with distinct destinations. */
function freeSteps(st: GameState): Record<string, string> {
  const map = st.maps[st.currentMapId!] as GameMap;
  const pcs = Object.values(st.entities).filter((e) => e.kind === "pc");
  const taken = new Set(pcs.map((e) => `${e.x},${e.y}`));
  const dirs: [string, number, number][] = [["north", 0, -1], ["south", 0, 1], ["east", 1, 0], ["west", -1, 0]];
  const out: Record<string, string> = {};
  for (const pc of pcs) {
    const d = dirs.find(([, dx, dy]) => isWalkable(map, pc.x + dx, pc.y + dy) && !taken.has(`${pc.x + dx},${pc.y + dy}`));
    if (!d) throw new Error("no free step for the test");
    taken.add(`${pc.x + d[1]},${pc.y + d[2]}`);
    out[pc.id] = d[0];
  }
  return out;
}

function ownedBy(t: Table, c: TestClient): EntityView {
  return t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id === c.playerId)!;
}

describe("intent router", () => {
  it("an all-mechanical beat resolves with the engine and makes zero DM calls", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const steps = freeSteps(stateOf(h));
    const a = ownedBy(t, t.a);
    const b = ownedBy(t, t.b);
    const startA = { x: stateOf(h).entities[a.id]!.x, y: stateOf(h).entities[a.id]!.y };
    say(t.a, `I walk ${steps[a.id]}`);
    say(t.b, `go ${steps[b.id]}.`);
    await until(() => stateOf(h!).entities[a.id]!.x !== startA.x || stateOf(h!).entities[a.id]!.y !== startA.y);
    await gameOf(h).idle();
    await sleep(100);
    expect(provider.dmRequests().length).toBe(before);
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/steps from/);
  });

  it("a mixed beat makes one DM call, with the mechanical step passed as an engine line", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const steps = freeSteps(stateOf(h));
    const a = ownedBy(t, t.a);
    say(t.a, `walk ${steps[a.id]}`);
    say(t.b, "I greet the ferryman warmly and ask about the tide");
    await until(() => provider.dmRequests().length === before + 1);
    await gameOf(h).idle();
    expect(provider.dmRequests().length).toBe(before + 1);
    const content = provider.dmRequests().at(-1)!.messages[0]!.content;
    expect(content).toContain("steps from");
    expect(content).toContain("greet the ferryman");
  });

  it("an empty beat makes no model call and offers a prompt", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const mark = t.a.mark();
    // the wire schema already rejects blank text; the game guards the same case for other callers
    gameOf(h).handleSay(h.server.rooms.all()[0]!.players[0]!, "   ", "ic");
    await t.a.waitMsg((m) => (m.type === "chips" || (m.type === "log" && /Say or do something/.test(m.payload.text))), { from: mark });
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
  });

  it("/ooc typed in character never reaches the DM", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const mark = t.b.mark();
    say(t.a, "/ooc back in two minutes");
    const chat = await t.b.wait("chat", () => true, { from: mark });
    expect(chat.payload.channel).toBe("ooc");
    expect(chat.payload.text).toBe("back in two minutes");
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
  });

  it("with the router off, a mechanical beat still goes to the DM", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, config: { intentRouter: false } });
    const t = await startedTable(h);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const steps = freeSteps(stateOf(h));
    const a = ownedBy(t, t.a);
    const b = ownedBy(t, t.b);
    say(t.a, `I walk ${steps[a.id]}`);
    say(t.b, `go ${steps[b.id]}`);
    await until(() => provider.dmRequests().length === before + 1);
  });
});

describe("deterministic combat narration", () => {
  async function startFight(t: Table, provider: ReturnType<typeof scriptedProvider>, roles: ("standard" | "boss" | "elite")[]) {
    const snap = t.a.lastSnapshot()!;
    const [p1, p2] = snap.entities.filter((e) => e.kind === "pc") as [EntityView, EntityView];
    const refs = roles.map((_, i) => `en_foe_${i}`);
    provider.queueDm(dmReply([
      ...roles.map((role, i) => ({ type: "create_enemy", concept: `A hollow-eyed marsh brute number ${i}`, role, setting_notes: "", ref: refs[i] })),
      ...refs.map((ref, i) => ({ type: "spawn_entity", archetype_id: ref, map_id: snap.map.id, x: p1.x + 1 + i, y: p1.y + 1, count: 1 })),
      { type: "start_combat", participants: [p1.id, p2.id, ...refs], difficulty: "standard" },
    ]));
    const mark = t.a.mark();
    say(t.a, "I attack the brutes!");
    say(t.b, "I draw my weapon.");
    await t.a.wait("combat_state", () => true, { from: mark });
    await gameOf(h!).idle();
    // make the fight survivable and long so nothing ends it by accident
    const st = stateOf(h!);
    for (const e of Object.values(st.entities) as Entity[]) { e.hp = 500; e.hpMax = 500; }
    const enemies = Object.values(st.entities).filter((e) => e.kind === "enemy");
    return { p1, p2, enemies, mark };
  }

  const roundOf = (harness: Harness) => stateOf(harness).combat?.round ?? 0;

  it("an ordinary round makes zero DM calls and the engine narrates it", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: constantRandom(0.5) });
    const t = await startedTable(h);
    const { mark } = await startFight(t, provider, ["standard"]);
    const before = provider.dmRequests().length;
    const typed = "I shout a challenge at the brute";
    say(t.a, typed); // free text during combat is not dropped, only held for the next DM call
    for (let i = 0; i < 300 && roundOf(h) < 2; i++) {
      const active = stateOf(h).combat?.active_id;
      if (active && stateOf(h).entities[active]?.kind === "pc") { void t.a.request("end_turn", {}); void t.b.request("end_turn", {}); }
      await sleep(15);
    }
    expect(roundOf(h)).toBeGreaterThanOrEqual(2);
    await gameOf(h).idle();
    const chunk = await t.a.waitMsg((m) => m.type === "narration_chunk" && m.payload.turn_id.startsWith("n") && m.payload.done && m.payload.text.length > 0, { from: mark });
    expect(chunk).toBeTruthy();
    expect(provider.dmRequests().length).toBe(before);
    expect(stateOf(h).combat).toBeTruthy();
  });

  it("a boss or elite going down makes one DM call; a standard enemy going down does not", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: constantRandom(0.5) });
    const t = await startedTable(h);
    const { enemies } = await startFight(t, provider, ["boss", "standard"]);
    const game = gameOf(h);
    const [boss, grunt] = enemies as [Entity, Entity];
    const archetypes = stateOf(h).archetypes;
    const roleOf = (e: Entity) => archetypes[e.refId]?.role;
    const bossE = roleOf(boss) === "boss" ? boss : grunt;
    const gruntE = bossE === boss ? grunt : boss;
    expect(roleOf(bossE)).toBe("boss");

    const calls = () => provider.dmRequests().length;
    let base = calls();
    game["publish"]([{ type: "defeated", entityId: gruntE.id, entityName: gruntE.name }]);
    await game.enqueue(() => game["advanceCombat"]());
    expect(calls()).toBe(base);

    provider.queueDm(dmReply([]));
    base = calls();
    game["publish"]([{ type: "defeated", entityId: bossE.id, entityName: bossE.name }]);
    await game.enqueue(() => game["advanceCombat"]());
    expect(calls()).toBe(base + 1);
    // the flag is consumed: nothing more is called
    await game.enqueue(() => game["advanceCombat"]());
    expect(calls()).toBe(base + 1);
  });

  it("a PC dropping to 0 HP makes one DM call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: constantRandom(0.5) });
    const t = await startedTable(h);
    const { p1 } = await startFight(t, provider, ["standard"]);
    const game = gameOf(h);
    provider.queueDm(dmReply([]));
    const base = provider.dmRequests().length;
    game["publish"]([{ type: "downed", entityId: p1.id, entityName: p1.name }]);
    await game.enqueue(() => game["advanceCombat"]());
    expect(provider.dmRequests().length).toBe(base + 1);
  });

  it("player free text typed in combat reaches the next DM call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: constantRandom(0.5) });
    const t = await startedTable(h);
    const { p1 } = await startFight(t, provider, ["standard"]);
    const game = gameOf(h);
    say(t.a, "I tell the brute we only want to talk");
    await sleep(100);
    provider.queueDm(dmReply([]));
    game["publish"]([{ type: "downed", entityId: p1.id, entityName: p1.name }]);
    await game.enqueue(() => game["advanceCombat"]());
    expect(provider.dmRequests().at(-1)!.messages[0]!.content).toContain("we only want to talk");
  });
});
