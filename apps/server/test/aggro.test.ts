import { afterEach, describe, expect, it } from "vitest";
import {
  aggroCheck, applyDmActions, cloneState, createRng, designSpriteOffline, endCombat, registerArchetype, STARTER_BRIEFS, type GameState,
} from "@aedm/engine";
import type { Enemy, EntityView } from "@aedm/schemas";
import { dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type Scripted, type Table } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const gameOf = (harness: Harness) => harness.server.rooms.all()[0]!.game!;
const stateOf = (harness: Harness): GameState => gameOf(harness).state;
const dmCount = (p: Scripted) => p.dmRequests().length;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  expect(cond()).toBe(true);
}

const RAT: Enemy = {
  v: 1, name: "Marsh Rat", concept: "A marsh rat", role: "minion",
  stats: { hp: 4, defense: 10, attack_bonus: 1, speed: 6, damage_dice: "1d4" },
  weakness: null, resistance: null, behavior: ["Closes to melee"], loot_hint: "", sprite_tags: [], abilities: [],
};

/**
 * The test map is the 31 x 35 starter town. Party characters stand at about (7,7). The rat goes to (25,7), eighteen tiles away,
 * so nothing notices anyone until a character walks into range (`rules.ai.aggro.radius`).
 */
function setup(harness: Harness, t: Table, opts: { wallAt?: number; doorAt?: [number, number] } = {}): { rat: string; pcs: EntityView[]; mapId: string } {
  const game = gameOf(harness);
  let st = cloneState(game.state);
  const mapId = st.currentMapId!;
  {
    // the tests place creatures along row 7, so make that stretch open ground whatever the generator put there
    const map = structuredClone(st.maps[mapId]!);
    for (const l of map.layers) {
      if (l.type !== "tilelayer" || (l.name !== "walls" && l.name !== "above")) continue;
      for (let y = 5; y <= 9; y++) for (let x = 12; x <= 28; x++) l.data[y * map.width + x] = 0;
    }
    st.maps[mapId] = map;
  }
  if (opts.wallAt !== undefined) {
    const map = structuredClone(st.maps[mapId]!);
    const walls = map.layers.find((l) => l.name === "walls");
    if (walls?.type === "tilelayer") for (let y = 0; y < map.height; y++) walls.data[y * map.width + opts.wallAt] = opts.doorAt && y === opts.doorAt[1] ? 0 : 1;
    const objects = map.layers.find((l) => l.type === "objectgroup");
    if (opts.doorAt && objects?.type === "objectgroup") objects.objects.push({ type: "interactable", id: "d_test", kind: "door", state: "closed", x: opts.doorAt[0], y: opts.doorAt[1] });
    st.maps[mapId] = map;
  }
  const reg = registerArchetype(st, RAT);
  if (!reg.ok) throw new Error(reg.errors.join("; "));
  st = reg.state;
  const id = "ei_rat";
  st.entities[id] = {
    id, kind: "enemy", name: "Marsh Rat", mapId, x: 25, y: 7, hp: 4, hpMax: 4, conditions: [], shield: 0,
    sprite: designSpriteOffline({ concept: "a marsh rat", name: "Marsh Rat", role: "minion", kind: "enemy" }, 3),
    refId: reg.archetype.id as string, disposition: "hostile", cooldowns: {}, usesLeft: {}, checkBonuses: [],
  };
  game.state = st;
  expect(aggroCheck(st)).toBeNull(); // placing it triggers nothing
  return { rat: id, pcs: t.a.lastSnapshot()!.entities.filter((e) => e.kind === "pc") as EntityView[], mapId };
}

const pcA = (t: Table) => t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id === t.a.playerId)!.id;
const pcB = (t: Table) => t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id !== t.a.playerId)!.id;

async function walkTo(harness: Harness, t: Table, x: number, y: number): Promise<void> {
  const id = pcA(t);
  const r = await t.a.request("move_intent", { x, y });
  expect(r.type).not.toBe("error");
  await until(() => { const e = stateOf(harness).entities[id]!; return (e.x === x && e.y === y) || stateOf(harness).combat !== null; }, 6000);
}

describe("aggro", () => {
  it("walking into view of a hostile creature starts the fight with zero DM calls", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5 });
    const t = await startedTable(h);
    setup(h, t);
    await gameOf(h).idle();
    const before = dmCount(provider);
    const mark = t.a.mark();
    await sleep(100);
    expect(stateOf(h).combat).toBeNull(); // not at spawn
    await walkTo(h, t, 19, 7);
    await t.a.wait("combat_state", () => true, { from: mark });
    await gameOf(h).idle();
    expect(stateOf(h).combat).not.toBeNull();
    const walker = stateOf(h).entities[pcA(t)]!;
    expect(walker.x).toBeLessThan(19); // the walk stopped when the fight began
    expect(dmCount(provider)).toBe(before);
    const open = await t.a.wait("narration_chunk", (c) => c.done && c.text.includes("Marsh Rat"), { from: mark });
    expect(open.payload.text).not.toMatch(/attack(s|ed)? Marsh Rat/); // noticed, not a character's attack
    const pending = gameOf(h).pendingEngineLines.join(" ");
    expect(pending).toContain("noticed the party");
    expect(pending).toContain("without the DM");
  });

  it("a single step toward a creature in range triggers it, but placing the creature does not", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5 });
    const t = await startedTable(h);
    setup(h, t);
    const game = gameOf(h);
    const st = cloneState(game.state);
    st.entities[pcA(t)]!.x = 16; st.entities[pcA(t)]!.y = 7; // nine tiles from the rat, out of range
    st.entities[pcB(t)]!.x = 15; st.entities[pcB(t)]!.y = 7;
    game.state = st;
    await sleep(100);
    expect(stateOf(h).combat).toBeNull();
    const before = dmCount(provider);
    const r = await t.a.request("move_intent", { direction: "e" });
    expect(r.type).not.toBe("error");
    await until(() => stateOf(h!).combat !== null);
    expect(dmCount(provider)).toBe(before);
  });

  it("a wall or a closed door between them blocks it", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5 });
    const t = await startedTable(h);
    setup(h, t, { wallAt: 21 });
    await walkTo(h, t, 19, 7);
    await sleep(100);
    expect(stateOf(h).combat).toBeNull();
    await h.stop();

    h = await startHarness({ provider: scriptedProvider(), random: () => 0.5 });
    const t2 = await startedTable(h);
    setup(h, t2, { wallAt: 21, doorAt: [21, 7] });
    await walkTo(h, t2, 19, 7);
    await sleep(100);
    expect(stateOf(h).combat).toBeNull();
  });

  it("after a truce the same creature does not pull the party back in", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5 });
    const t = await startedTable(h);
    const { rat } = setup(h, t);
    const mark = t.a.mark();
    await walkTo(h, t, 19, 7);
    await t.a.wait("combat_state", () => true, { from: mark });
    const g = gameOf(h);
    await g.enqueue(() => {
      const r = endCombat(g.state, createRng(1), "truce");
      expect(r.ok).toBe(true);
      (g as unknown as { commit(s: GameState): void }).commit(r.state);
    });
    await g.idle();
    expect(stateOf(h).combat).toBeNull();
    expect(stateOf(h).entities[rat]!.calm).toBe(true);
    const me = stateOf(h).entities[pcA(t)]!;
    const foe = stateOf(h).entities[rat]!;
    await walkTo(h, t, Math.max(me.x + 1, foe.x - 2), foe.y);
    await sleep(150);
    expect(stateOf(h).combat).toBeNull();
    expect(dist(stateOf(h).entities[pcA(t)]!, stateOf(h).entities[rat]!)).toBeLessThanOrEqual(4);
  });

  it.each([
    ["aggro: false", { aggro: false }],
    ["combatDm: full", { combatDm: "full" as const }],
  ])("never auto-starts with %s", async (_name, config) => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5, config });
    const t = await startedTable(h);
    setup(h, t);
    await walkTo(h, t, 22, 7);
    await sleep(150);
    expect(stateOf(h).combat).toBeNull();
    expect(stateOf(h).entities[pcA(t)]!.x).toBe(22);
  });
});

describe("allies keep up", () => {
  function addAlly(harness: Harness): string {
    const game = gameOf(harness);
    const r = applyDmActions(game.state, createRng(5), [{ type: "create_npc", name: "Odalys", concept: "A ferrywoman.", role: "ally", map_id: game.state.currentMapId!, x: 5, y: 7, sprite_tags: ["coat"] }], {
      presentCharacterIds: Object.keys(game.state.characters), partyLevel: 1,
    });
    expect(r.rejected).toEqual([]);
    game.state = r.state;
    return Object.values(r.state.npcs).find((n) => n.name === "Odalys")!.id;
  }

  it("an allied NPC follows when the party walks away", async () => {
    h = await startHarness({ provider: scriptedProvider(), random: () => 0.5 });
    const t = await startedTable(h);
    const game = gameOf(h);
    const ally = addAlly(h);
    const st = cloneState(game.state);
    st.entities[pcB(t)]!.x = 20; st.entities[pcB(t)]!.y = 6; // the nearest character is far from the ally
    game.state = st;
    await walkTo(h, t, 19, 7);
    await sleep(100);
    const s = stateOf(h);
    const nearest = Math.min(...Object.values(s.entities).filter((e) => e.kind === "pc").map((p) => dist(p, s.entities[ally]!)));
    expect(nearest).toBeLessThanOrEqual(4);
    expect(s.npcs[ally]).toMatchObject({ x: s.entities[ally]!.x, y: s.entities[ally]!.y });
  });

  it("an allied NPC near the party comes along to a freshly generated map", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, random: () => 0.5 });
    const t = await startedTable(h);
    const ally = addAlly(h);
    const before = stateOf(h).currentMapId;
    provider.queueDm(dmReply([{ type: "generate_map", brief: STARTER_BRIEFS.town }]));
    t.a.send("say", { text: "We head out to find the next place.", channel: "ic" });
    t.b.send("say", { text: "Lead on.", channel: "ic" });
    await until(() => stateOf(h!).currentMapId !== before, 6000);
    const s = stateOf(h);
    expect(s.entities[ally]!.mapId).toBe(s.currentMapId);
    const taken = Object.values(s.entities).filter((e) => e.mapId === s.currentMapId).map((e) => `${e.x},${e.y}`);
    expect(new Set(taken).size).toBe(taken.length);
  });
});
