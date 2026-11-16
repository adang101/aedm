import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { campaignOf, getObjects, locationEnemyRequests, type GameState } from "@aedm/engine";
import { CAMPAIGN_BIBLE } from "@aedm/engine/testkit";
import { createFakeProvider, type FakeProvider } from "@aedm/llm";
import type { StoryBible } from "@aedm/schemas";
import { dmReply, scriptedProvider, sleep, startHarness, lobbyOfTwo, type Harness, type Scripted, type Table } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const gameOf = (harness: Harness) => harness.server.rooms.all()[0]!.game!;
const stateOf = (harness: Harness): GameState => gameOf(harness).state;

/** The testkit's hand-written plan, with the second milestone a plain `reach_location` of the dock (no model needed to finish it). */
const BIBLE: StoryBible = {
  ...CAMPAIGN_BIBLE,
  milestones: CAMPAIGN_BIBLE.milestones.map((m) => (m.id === "m2" ? { ...m, trigger: { type: "reach_location" as const, location: "l_dock" } } : m)),
};

/** Fake provider whose story bible is `bible`; the DM is scripted and everything else is the offline improv. */
function planProvider(bible: StoryBible = BIBLE, enemyDelayMs = 0): Scripted & FakeProvider {
  const base = scriptedProvider();
  const p = createFakeProvider(async (req) => {
    if (req.purpose === "bible") return JSON.stringify(bible);
    if (req.purpose === "enemy" && enemyDelayMs > 0) await sleep(enemyDelayMs);
    return (await base.complete(req)).text;
  }) as Scripted & FakeProvider;
  p.queueDm = base.queueDm;
  p.dmRequests = () => p.requests.filter((r) => r.purpose === "dm");
  return p;
}

async function planTable(provider: Scripted): Promise<Table> {
  h = await startHarness({ provider });
  const t = await lobbyOfTwo(h);
  await t.a.request("update_settings", { plot_pattern: "overcoming_the_monster", plot_arc: "fall_rise" });
  const ma = t.a.mark();
  const mb = t.b.mark();
  const r = await t.a.request("start_game", {});
  if (r.type === "error") throw new Error(JSON.stringify(r.payload));
  await t.a.wait("narration_chunk", (p) => p.done, { from: ma });
  await t.b.wait("narration_chunk", (p) => p.done, { from: mb });
  return t;
}

async function until(pred: () => boolean, ms = 6000): Promise<void> {
  for (let i = 0; i < ms / 20 && !pred(); i++) await sleep(20);
  expect(pred()).toBe(true);
}

/**
 * Walk a character to a tile with a click-to-move and wait until it gets there (or the map changes). A walk can stop short on
 * its own (a trap is noticed on the way, on whatever map this run's seed made), so ask again, as a player would.
 */
async function walkTo(t: Table, charId: string, x: number, y: number): Promise<void> {
  const mapId = stateOf(h!).currentMapId;
  const arrived = (): boolean => {
    const st = stateOf(h!);
    const e = st.entities[charId];
    return st.currentMapId !== mapId || (!!e && e.x === x && e.y === y);
  };
  for (let attempt = 0; attempt < 6 && !arrived(); attempt++) {
    const r = await t.a.request("move_intent", { x, y });
    if (arrived()) break;
    expect(r.type, JSON.stringify(r)).toBe("presence");
    // wait while the character keeps moving; stop waiting once it has stood still for a while
    let last = "";
    let still = 0;
    for (let i = 0; i < 300 && !arrived() && still < 25; i++) {
      await sleep(20);
      const e = stateOf(h!).entities[charId];
      const pos = e ? `${e.x},${e.y}` : "";
      still = pos === last ? still + 1 : 0;
      last = pos;
    }
  }
  expect(arrived()).toBe(true);
}

const exitOf = (st: GameState, name: RegExp) => getObjects(st.maps[st.currentMapId as string]!).find((o) => o.type === "exit" && name.test(o.name))!;
const pcOf = (t: Table, st: GameState) => Object.values(st.entities).find((e) => e.kind === "pc" && e.refId === t.a.lastSnapshot()!.party[0]!.id)!;

describe("campaign start", () => {
  it("builds the first location as the map, places its cast and shows the first objective", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    const st = stateOf(h!);
    const b = campaignOf(st);
    expect(b.locations.l_square).toBe(st.currentMapId);
    expect(st.maps[st.currentMapId as string]!.meta.setting.name).toBe(BIBLE.locations![0]!.setting.name);
    const tam = Object.values(st.entities).find((e) => e.name === "Old Tam")!;
    expect(tam).toBeTruthy();
    expect(tam.mapId).toBe(st.currentMapId);
    expect(b.cast.c_tam).toBe(tam.id);

    const snap = t.a.lastSnapshot()!;
    expect(snap.map.id).toBe(st.currentMapId);
    expect(snap.objective!.stage.index).toBe(0);
    expect(snap.objective!.milestones[0]).toMatchObject({ id: "m1", done: false, hint: expect.stringMatching(/^Talk to Old Tam at (the |Hollowmere Square)/) }); // at a landmark when Tam stands at one
    expect(t.a.invalid).toEqual([]);

    // the opening DM turn names the place and the first objective
    const opening = provider.dmRequests()[0]!.messages[0]!.content;
    expect(opening).toContain("Hollowmere Square");
    expect(opening).toContain("Talk to Old Tam");
  });
});

describe("campaign travel and objectives", () => {
  it("an exit builds and enters the next location, completes reach_location with no DM call, and broadcasts objective_update", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    const pc = pcOf(t, stateOf(h!));

    // m1: talking to Tam is tracked by the engine
    const tam = Object.values(stateOf(h!).entities).find((e) => e.name === "Old Tam")!;
    const m0 = t.a.mark();
    const r = await t.a.request("act", { verb: "talk", target_id: tam.id });
    expect(r.type).toBe("presence");
    const first = await t.a.wait("objective_update", (o) => !!o.completed?.some((c) => c.id === "m1"), { from: m0 });
    expect(first.payload.stage.index).toBe(1);
    expect(first.payload.progress).toEqual({ done: 1, total: 6 });
    // the talk itself reaches the DM as an intent; once it has answered, its input carried the engine's completion line
    await t.a.wait("narration_chunk", (p) => p.done, { from: m0 });
    await gameOf(h!).idle();
    expect(provider.dmRequests().at(-1)!.messages[0]!.content).toContain("Objective complete: Talk to Old Tam");

    // walk to the exit: the next location is built and entered with no model call for the DM
    const dmCalls = provider.dmRequests().length;
    const ex = exitOf(stateOf(h!), /dock/i);
    const m1 = t.a.mark();
    await walkTo(t, pc.id, ex.x, ex.y);
    const second = await t.a.wait("objective_update", (o) => !!o.completed?.some((c) => c.id === "m2"), { from: m1 });
    expect(second.payload.progress.done).toBe(2);
    const snap = await t.a.wait("state_snapshot", (s) => s.map.meta.setting.name === BIBLE.locations![1]!.setting.name, { from: m1 });
    const st = stateOf(h!);
    expect(campaignOf(st).locations.l_dock).toBe(snap.payload.map.id);
    expect(campaignOf(st).visited).toContain("l_dock");
    expect(st.currentMapId).toBe(snap.payload.map.id);
    expect(second.payload.stage.index).toBe(2);
    expect(Object.values(st.entities).filter((e) => e.kind === "pc").every((e) => e.mapId === st.currentMapId)).toBe(true);
    await gameOf(h!).idle();
    expect(provider.dmRequests().length).toBe(dmCalls);
    expect(t.a.invalid).toEqual([]);

    // the party can walk back: an already built location is simply entered (no new map)
    const maps = Object.keys(st.maps).length;
    const back = exitOf(st, /square/i);
    const m2 = t.a.mark();
    await walkTo(t, pc.id, back.x, back.y);
    await t.a.wait("state_snapshot", (s) => s.map.id === campaignOf(stateOf(h!)).locations.l_square, { from: m2 });
    expect(Object.keys(stateOf(h!).maps)).toHaveLength(maps);
  });

  it("builds encounter creatures for the party level and installs them on arrival", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    const st0 = stateOf(h!);
    // a party of level 3: the creatures prepared in the background at level 1 are refitted when the location is installed
    const grown = structuredClone(st0);
    for (const c of Object.values(grown.characters)) c.level = 3;
    gameOf(h!).state = grown;
    const pc = pcOf(t, st0);
    const tam = Object.values(st0.entities).find((e) => e.name === "Old Tam")!;
    await t.a.request("act", { verb: "talk", target_id: tam.id });
    await gameOf(h!).idle();
    await walkTo(t, pc.id, exitOf(stateOf(h!), /dock/i).x, exitOf(stateOf(h!), /dock/i).y);
    await gameOf(h!).idle();
    await walkTo(t, pc.id, exitOf(stateOf(h!), /marsh/i).x, exitOf(stateOf(h!), /marsh/i).y);
    await until(() => !!campaignOf(stateOf(h!)).locations.l_marsh && stateOf(h!).currentMapId === campaignOf(stateOf(h!)).locations.l_marsh);
    const st = stateOf(h!);
    const enc = campaignOf(st).encounters.e_sentries!;
    expect(enc.entityIds).toHaveLength(3);
    expect(locationEnemyRequests(st.bible, "l_marsh")).toHaveLength(2);
    // the planned fight fits the engine's standard budget for this party (two level-3 heroes)
    const threat = enc.entityIds.reduce((n, id) => n + (st.archetypes[st.entities[id]!.refId]!.threat ?? 0), 0);
    expect(threat).toBeLessThanOrEqual(2 * (10 + 3 * 3) + 1e-9);
    expect(Object.values(st.entities).some((e) => e.name === "Wren Ashby")).toBe(true);
  });

  it("a slow enemy builder never blocks play: the DM keeps answering until the building location is ready", async () => {
    const provider = planProvider(BIBLE, 700);
    const t = await planTable(provider);
    const pc = pcOf(t, stateOf(h!));
    const tam = Object.values(stateOf(h!).entities).find((e) => e.name === "Old Tam")!;
    await t.a.request("act", { verb: "talk", target_id: tam.id });
    await until(() => stateOf(h!).bible.milestones[0]!.completed);
    await walkTo(t, pc.id, exitOf(stateOf(h!), /dock/i).x, exitOf(stateOf(h!), /dock/i).y);
    await until(() => stateOf(h!).currentMapId === campaignOf(stateOf(h!)).locations.l_dock);
    const dock = stateOf(h!).currentMapId;
    // the marsh (two sentries to build) is still being prepared in the background; step onto its exit and keep talking meanwhile
    const ex = exitOf(stateOf(h!), /marsh/i);
    const m = t.a.mark();
    await t.a.request("move_intent", { x: ex.x, y: ex.y });
    t.a.send("say", { text: "I keep watch.", channel: "ic" });
    t.b.send("say", { text: "So do I.", channel: "ic" });
    await t.a.wait("narration_chunk", (p) => p.done, { from: m });
    expect(stateOf(h!).currentMapId).toBe(dock); // answered while the marsh is not ready yet
    await walkTo(t, pc.id, ex.x, ex.y); // finish the walk if a noticed trap stopped it short
    await until(() => stateOf(h!).currentMapId === campaignOf(stateOf(h!)).locations.l_marsh, 8000);
    expect(t.a.invalid).toEqual([]);
  });

  it("a DM complete_milestone for a tracked milestone is refused and the view is unchanged", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    provider.queueDm(dmReply([{ type: "complete_milestone", milestone_id: "m1" }]));
    t.a.send("say", { text: "I look around.", channel: "ic" });
    t.b.send("say", { text: "I look too.", channel: "ic" });
    await sleep(300);
    await gameOf(h!).idle();
    expect(stateOf(h!).bible.milestones.find((m) => m.id === "m1")!.completed).toBe(false);
  });

  it("tells the DM when the story is finished", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    // make every milestone a story milestone, then let the DM complete them all
    const game = gameOf(h!);
    const s = structuredClone(game.state);
    for (const m of s.bible.milestones) delete m.trigger;
    game.state = s;
    const m0 = t.a.mark();
    provider.queueDm(dmReply([
      { type: "complete_milestone", milestone_id: "m1" },
      { type: "complete_milestone", milestone_id: "m2" },
      { type: "complete_milestone", milestone_id: "m3" },
      { type: "complete_milestone", milestone_id: "m4" },
      { type: "complete_milestone", milestone_id: "m5" },
      { type: "complete_milestone", milestone_id: "m6" },
    ]));
    t.a.send("say", { text: "We finish it.", channel: "ic" });
    t.b.send("say", { text: "Together.", channel: "ic" });
    const done = await t.a.wait("objective_update", (o) => o.finished, { from: m0 });
    expect(done.payload.progress.done).toBe(6);
    expect(gameOf(h!).pendingEngineLines.join("\n")).toContain("every objective of the story is complete");
  });
});

describe("campaign route view", () => {
  /** Every route view that went over the wire to this client, as raw JSON text. */
  const routeWire = (c: Table["a"], from = 0): string[] => [
    ...c.all("state_snapshot", from).flatMap((m) => (m.payload.route ? [JSON.stringify(m.payload.route)] : [])),
    ...c.all("route_update", from).map((m) => JSON.stringify(m.payload)),
  ];

  it("starts with the first place current and its neighbour known; nothing further is on the wire", async () => {
    const t = await planTable(planProvider());
    const route = t.a.lastSnapshot()!.route!;
    expect(route.nodes.map((n) => `${n.name}:${n.state}`)).toEqual(["Hollowmere Square:current", "The Rotting Dock:known"]);
    expect(route.current).toBe(route.nodes[0]!.id);
    expect(route.markers).toEqual([{ milestone_id: "m1", node: route.nodes[0]!.id }]);
    expect(route.nodes[1]!.exit).toMatchObject({ label: "To The Rotting Dock" });
    for (const c of [t.a, t.b]) {
      const wire = routeWire(c).join("\n");
      expect(wire).not.toBe("");
      for (const secret of ["Lantern Marsh", "Drowned Crypt", "Choir", "l_marsh", "l_crypt", "l_dock", "Lens", "Signet", "e_boss"]) expect(wire).not.toContain(secret);
    }
  });

  it("travelling updates the view for everyone, and places two steps away stay off the wire", async () => {
    const t = await planTable(planProvider());
    const pc = pcOf(t, stateOf(h!));
    const tam = Object.values(stateOf(h!).entities).find((e) => e.name === "Old Tam")!;
    await t.a.request("act", { verb: "talk", target_id: tam.id });
    await gameOf(h!).idle();
    const m0 = t.a.mark();
    const mb = t.b.mark();
    const ex = exitOf(stateOf(h!), /dock/i);
    await walkTo(t, pc.id, ex.x, ex.y);
    await t.a.wait("state_snapshot", (s) => s.map.id === campaignOf(stateOf(h!)).locations.l_dock, { from: m0 });
    await gameOf(h!).idle();
    for (const [c, from] of [[t.a, m0], [t.b, mb]] as const) {
      const last = JSON.parse(routeWire(c, from).at(-1)!) as NonNullable<ReturnType<Table["a"]["lastSnapshot"]>>["route"];
      expect(last!.nodes.map((n) => `${n.name}:${n.state}`)).toEqual(["Hollowmere Square:visited", "The Rotting Dock:current", "Lantern Marsh:known"]);
      expect(last!.nodes[0]!.summary).toBeTruthy();
      expect(last!.nodes[2]!.summary).toBeUndefined();
      expect(last!.nodes[2]!.exit).toMatchObject({ label: "To Lantern Marsh" });
      expect(routeWire(c, from).join("\n")).not.toMatch(/Drowned Crypt|Choir|l_crypt|e_boss/);
    }
    expect(t.a.invalid).toEqual([]);
  });
});

describe("campaign saves", () => {
  it("restores the plan, the built locations and the objective, and keeps playing", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    const pc = pcOf(t, stateOf(h!));
    const tam = Object.values(stateOf(h!).entities).find((e) => e.name === "Old Tam")!;
    await t.a.request("act", { verb: "talk", target_id: tam.id });
    await gameOf(h!).idle();
    await walkTo(t, pc.id, exitOf(stateOf(h!), /dock/i).x, exitOf(stateOf(h!), /dock/i).y);
    await gameOf(h!).idle();
    const before = structuredClone(campaignOf(stateOf(h!)));

    await t.a.request("request_save", { name: "dock" });
    const created = await t.a.wait("save_created", (s) => s.name === "dock");
    // walk on so the load has something to undo
    const m = t.a.mark();
    const back = exitOf(stateOf(h!), /square/i);
    await walkTo(t, pc.id, back.x, back.y);
    await t.a.wait("state_snapshot", () => true, { from: m });

    const m2 = t.a.mark();
    expect((await t.a.request("load_save", { save_id: created.payload.save_id })).type).toBe("presence");
    const snap = await t.a.wait("state_snapshot", () => true, { from: m2 });
    expect(campaignOf(stateOf(h!))).toEqual(before);
    expect(snap.payload.map.id).toBe(before.locations.l_dock);
    expect(snap.payload.objective!.stage.index).toBe(2);
    expect(snap.payload.objective!.progress.done).toBe(2);

    // and the restored game still travels: back to the square (built) with objective tracking intact
    const m3 = t.a.mark();
    const back2 = exitOf(stateOf(h!), /square/i);
    await walkTo(t, pc.id, back2.x, back2.y);
    await t.a.wait("state_snapshot", (s) => s.map.id === before.locations.l_square, { from: m3 });
  });

  it("an old save without a plan still loads and plays", async () => {
    const provider = planProvider();
    const t = await planTable(provider);
    await gameOf(h!).idle();
    const roomId = h!.server.rooms.all()[0]!.id;
    await t.a.request("request_save", { name: "old" });
    const created = await t.a.wait("save_created", (s) => s.name === "old");
    const file = join(h!.saveDir, roomId, `${created.payload.save_id}.json`);
    const json = JSON.parse(await readFile(file, "utf8"));
    // what a save from before campaign plans looks like: no binding, no plan fields, no triggers or hints
    delete json.state.campaign;
    for (const k of ["locations", "cast", "encounters", "key_items", "ending"]) delete json.state.bible[k];
    for (const m of json.state.bible.milestones) { delete m.trigger; delete m.hint; }
    await writeFile(file, JSON.stringify(json));

    const m = t.a.mark();
    expect((await t.a.request("load_save", { save_id: created.payload.save_id })).type).toBe("presence");
    const snap = await t.a.wait("state_snapshot", () => true, { from: m });
    expect(snap.payload.objective!.stage.index).toBe(0);
    expect(t.a.invalid).toEqual([]);

    // play goes on: a beat gets a DM answer
    const m2 = t.a.mark();
    t.a.send("say", { text: "I look around.", channel: "ic" });
    t.b.send("say", { text: "I look too.", channel: "ic" });
    await t.a.wait("narration_chunk", (p) => p.done, { from: m2 });
    expect(stateOf(h!).campaign).toBeUndefined();
    expect(t.a.invalid).toEqual([]);
  });
});
