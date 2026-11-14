import { afterEach, describe, expect, it } from "vitest";
import { createFakeProvider } from "@aedm/llm";
import type { EntityView } from "@aedm/schemas";
import { dmReply, scriptedProvider, startedTable, startHarness, type Harness, type Scripted, type Table } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const gameOf = (harness: Harness) => harness.server.rooms.all()[0]!.game!;

/** A DM reply that builds, spawns and starts a fight against one enemy; both players speak so the beat closes. */
async function fightWithNewEnemy(t: Table, provider: Scripted, ref = "en_marsh_brute") {
  const snap = t.a.lastSnapshot()!;
  const [p1, p2] = snap.entities.filter((e) => e.kind === "pc") as [EntityView, EntityView];
  provider.queueDm(dmReply([
    { type: "create_enemy", concept: "A hollow-eyed marsh brute", role: "standard", setting_notes: "", ref },
    { type: "spawn_entity", archetype_id: ref, map_id: snap.map.id, x: p1.x + 1, y: p1.y + 1, count: 1 },
    { type: "start_combat", participants: [p1.id, p2.id, ref], difficulty: "standard" },
  ]));
  const mark = t.a.mark();
  t.a.send("say", { text: "I look for trouble.", channel: "ic" });
  t.b.send("say", { text: "I draw my weapon.", channel: "ic" });
  await t.a.wait("combat_state", () => true, { from: mark });
  await gameOf(h!).idle();
}

describe("enemy builder", () => {
  it("engine mode (default) builds the enemy without a model call and the fight still starts", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5 });
    const t = await startedTable(h);
    await fightWithNewEnemy(t, provider);
    expect(provider.requests.filter((r) => r.purpose === "enemy")).toEqual([]);
    const st = gameOf(h).state;
    expect(st.archetypes["en_marsh_brute"]).toMatchObject({ name: "Marsh Brute", role: "standard" });
    expect(Object.values(st.entities).some((e) => e.kind === "enemy" && e.refId === "en_marsh_brute")).toBe(true);
    expect(st.combat).not.toBeNull();
  });

  it("builds the same enemy for the same game seed", async () => {
    const make = async () => {
      const provider = scriptedProvider();
      h = await startHarness({ provider, random: () => 0.5 });
      const t = await startedTable(h);
      await fightWithNewEnemy(t, provider);
      const a = gameOf(h).state.archetypes["en_marsh_brute"]!;
      await h.stop();
      h = undefined;
      return JSON.stringify({ stats: a.stats, behavior: a.behavior, abilities: a.abilities.map((x) => x.name) });
    };
    expect(await make()).toBe(await make());
  });

  it("model mode asks the model for the enemy", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5, config: { enemyBuilder: "model" } });
    const t = await startedTable(h);
    await fightWithNewEnemy(t, provider);
    expect(provider.requests.filter((r) => r.purpose === "enemy").length).toBeGreaterThanOrEqual(1);
    expect(gameOf(h).state.archetypes["en_marsh_brute"]).toBeTruthy();
  });

  it("model mode falls back to the engine builder when the model call fails", async () => {
    const improv = createFakeProvider();
    const queue: string[] = [];
    const provider = createFakeProvider(async (req) => {
      if (req.purpose === "enemy" || req.purpose === "repair") return "this is not an enemy";
      if (req.purpose === "dm" && queue.length > 0) return queue.shift() as string;
      return (await improv.complete(req)).text;
    });
    h = await startHarness({ provider, random: () => 0.5, config: { enemyBuilder: "model" } });
    const t = await startedTable(h);
    const snap = t.a.lastSnapshot()!;
    const [p1, p2] = snap.entities.filter((e) => e.kind === "pc") as [EntityView, EntityView];
    queue.push(dmReply([
      { type: "create_enemy", concept: "A hollow-eyed marsh brute", role: "standard", setting_notes: "", ref: "en_marsh_brute" },
      { type: "spawn_entity", archetype_id: "en_marsh_brute", map_id: snap.map.id, x: p1.x + 1, y: p1.y + 1, count: 1 },
      { type: "start_combat", participants: [p1.id, p2.id, "en_marsh_brute"], difficulty: "standard" },
    ]));
    const mark = t.a.mark();
    t.a.send("say", { text: "I look for trouble.", channel: "ic" });
    t.b.send("say", { text: "I draw my weapon.", channel: "ic" });
    await t.a.wait("combat_state", () => true, { from: mark });
    expect(provider.requests.filter((r) => r.purpose === "enemy").length).toBeGreaterThanOrEqual(1);
    expect(gameOf(h).state.archetypes["en_marsh_brute"]).toMatchObject({ name: "Marsh Brute" });
    expect(gameOf(h).pendingEngineLines.join(" ")).not.toContain("no enemy was made");
  });
});
