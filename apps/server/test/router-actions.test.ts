import { afterEach, describe, expect, it } from "vitest";
import {
  applyDmActions, cloneState, createRng, findFreeTileNear, occupiedTiles, registerArchetype, RULES, type GameState,
} from "@aedm/engine";
import type { Enemy } from "@aedm/schemas";
import { scriptedProvider, sleep, startedTable, startHarness, type Harness, type Table, type TestClient } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const gameOf = (harness: Harness) => harness.server.rooms.all()[0]!.game!;
const stateOf = (harness: Harness): GameState => gameOf(harness).state;
const say = (c: TestClient, text: string) => c.send("say", { text, channel: "ic" });

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  expect(cond()).toBe(true);
}

const FOE: Enemy = {
  v: 1, name: "Robed Chorister", concept: "A cultist who borrows the voices of the drowned.", role: "standard",
  stats: { hp: 10, defense: 12, attack_bonus: 3, speed: 6, damage_dice: "1d6" },
  weakness: null, resistance: null, behavior: ["Closes to melee"], loot_hint: "", sprite_tags: ["robe"], abilities: [],
  appearance: "Pale robes dripping seawater.",
};

function pcOf(t: Table, c: TestClient): string {
  return t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id === c.playerId)!.id;
}

/** Put a healing draught in the first player's pack and a Robed Chorister two tiles from them. */
function stage(harness: Harness, t: Table): { a: string; b: string; foe: string } {
  const game = gameOf(harness);
  const a = pcOf(t, t.a);
  const b = pcOf(t, t.b);
  let st = cloneState(game.state);
  st.characters[a]!.inventory.push(
    { id: "it_dr", name: RULES.draught.name, kind: "consumable", value: RULES.draught.value },
    { id: "it_lamp", name: "Iron lantern", kind: "trinket", value: 3 },
  );
  st.entities[a]!.hp = 1;
  const reg = registerArchetype(st, FOE);
  if (!reg.ok) throw new Error(reg.errors.join("; "));
  const map = st.maps[st.currentMapId!]!;
  const e = st.entities[a]!;
  const at = findFreeTileNear(map, e.x + 2, e.y, occupiedTiles(reg.state, map.id))!;
  const spawned = applyDmActions(reg.state, createRng(1), [{ type: "spawn_entity", archetype_id: reg.archetype.id as string, map_id: map.id, x: at.x, y: at.y, count: 1 }], {
    presentCharacterIds: Object.keys(st.characters), partyLevel: 1,
  });
  st = spawned.state;
  game.state = st;
  return { a, b, foe: Object.values(st.entities).find((x) => x.kind === "enemy")!.id };
}

describe("router: look, pack, wait, items, creatures", () => {
  it("look around and wait resolve in the engine: the table sees the description, the DM is not called", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const mb = t.b.mark();
    say(t.a, "I look around");
    say(t.b, "wait");
    const log = await t.b.wait("log", (p) => p.kind === "narration" && /You are in/.test(p.text), { from: mb });
    expect(log.payload.text).toContain("Robed Chorister (hostile)");
    await gameOf(h).idle();
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
    const lines = gameOf(h).pendingEngineLines.join(" ");
    expect(lines).toMatch(/looks around the scene/);
    expect(lines).toMatch(/waits/);
    expect(lines).not.toContain("You are in"); // the DM hears that it happened, not the whole description
  });

  it("check my pack is private to the asker and makes no DM call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const ma = t.a.mark();
    const mb = t.b.mark();
    say(t.a, "check my pack");
    say(t.b, "do nothing");
    const mine = await t.a.wait("log", (p) => p.kind === "system" && /You are carrying/.test(p.text), { from: ma });
    expect(mine.payload.text).toContain("Iron lantern");
    await gameOf(h).idle();
    await sleep(150);
    expect(t.b.all("log", mb).some((m) => /You are carrying/.test(m.payload.text))).toBe(false);
    expect(provider.dmRequests().length).toBe(before);
  });

  it("drink the healing draught heals through the engine with no DM call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const { a } = stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    say(t.a, `drink the ${RULES.draught.name.toLowerCase()}`);
    say(t.b, "wait");
    await until(() => !stateOf(h!).characters[a]!.inventory.some((i) => i.id === "it_dr"));
    expect(stateOf(h).entities[a]!.hp).toBeGreaterThan(1);
    await gameOf(h).idle();
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/uses/);
  });

  it("examining a creature shows the engine's description and makes no DM call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const ma = t.a.mark();
    say(t.a, "examine the robed chorister");
    say(t.b, "wait");
    const log = await t.a.wait("log", (p) => p.kind === "narration" && /Pale robes dripping seawater/.test(p.text), { from: ma });
    expect(log.payload.text).toContain("unhurt");
    expect(log.payload.text).not.toMatch(/drowned|Closes to melee/); // concept and behavior are DM-only
    await gameOf(h).idle();
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
  });

  it("the examine act message on a creature is answered by the engine too", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const { foe } = stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const ma = t.a.mark();
    const r = await t.a.request("act", { verb: "examine", target_id: foe });
    expect(r.type).not.toBe("error");
    await t.a.wait("log", (p) => p.kind === "narration" && /Robed Chorister/.test(p.text), { from: ma });
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
  });

  it("an attack on an enemy is still the DM's call for now", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    say(t.a, "attack the robed chorister");
    say(t.b, "wait");
    await until(() => provider.dmRequests().length === before + 1);
    expect(provider.dmRequests().at(-1)!.messages[0]!.content).toContain("attack the robed chorister");
  });

  it("a use the engine cannot do falls back to the DM with an engine line", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const { b } = stage(h, t);
    const far = cloneState(stateOf(h));
    far.entities[b]!.x = 0;
    far.entities[b]!.y = 0;
    far.entities[pcOf(t, t.a)]!.x = 15;
    far.entities[pcOf(t, t.a)]!.y = 15;
    gameOf(h).state = far;
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    const name = far.characters[b]!.name;
    say(t.a, `use the ${RULES.draught.name.toLowerCase()} on ${name}`);
    say(t.b, "wait");
    await until(() => provider.dmRequests().length === before + 1);
    const content = provider.dmRequests().at(-1)!.messages[0]!.content;
    expect(content).toMatch(/could not do that/);
    expect(stateOf(h).characters[pcOf(t, t.a)]!.inventory.some((i) => i.id === "it_dr")).toBe(true);
  });

  it("using something that is not a draught goes straight to the DM", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    say(t.a, "use the iron lantern");
    say(t.b, "wait");
    await until(() => provider.dmRequests().length === before + 1);
    expect(provider.dmRequests().at(-1)!.messages[0]!.content).toContain("use the iron lantern");
  });
});
