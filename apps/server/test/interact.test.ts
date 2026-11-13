import { afterEach, describe, expect, it } from "vitest";
import {
  applyDmActions, cloneState, createRng, effectiveState, findFreeTileNear, findInteractable, occupiedTiles, registerArchetype, startCombat, type GameState,
} from "@aedm/engine";
import type { Enemy, MapObject } from "@aedm/schemas";
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

/** Put a chest (holding a brass key), a closed door, a lever-less sign and an altar around the first player's character. */
function stage(harness: Harness, t: Table): { pc: string; map: string } {
  const game = gameOf(harness);
  const st = cloneState(game.state);
  const pc = t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id === t.a.playerId)!.id;
  const e = st.entities[pc]!;
  const map = st.maps[st.currentMapId!]!;
  const obj = (o: Record<string, unknown>) => ({ type: "interactable", ...o }) as unknown as MapObject;
  const added = [
    obj({ id: "chest_t", kind: "chest", state: "closed", x: e.x + 1, y: e.y }),
    obj({ id: "door_t", kind: "door", state: "closed", x: e.x - 1, y: e.y }),
    obj({ id: "sign_t", kind: "sign", state: "closed", text: "Mind the second step.", x: e.x, y: e.y + 1 }),
    obj({ id: "altar_t", kind: "altar", state: "closed", x: e.x, y: e.y - 1 }),
  ];
  st.maps = { ...st.maps, [map.id]: { ...map, layers: map.layers.map((l) => (l.type === "objectgroup" ? { ...l, objects: [...l.objects, ...added] } : l)) } };
  st.containers.cn_t = {
    v: 1, id: "cn_t", kind: "chest", map_id: map.id, x: e.x + 1, y: e.y, label: "Chest", object_id: "chest_t",
    items: [{ id: "it_t1", name: "Brass key", kind: "quest", value: 0 }],
  };
  st.characters[pc]!.inventory.push({ id: "it_lamp", name: "Iron lantern", kind: "trinket", value: 3 });
  game.state = st;
  return { pc, map: map.id };
}

describe("act is resolved by the engine", () => {
  it("open a chest: the opener gets container_view, everyone gets the diff, and the DM is not called", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    const before = provider.dmRequests().length;
    const ma = t.a.mark();
    const mb = t.b.mark();
    t.a.send("act", { verb: "open", target_id: "chest_t" });
    const view = await t.a.wait("container_view", () => true, { from: ma });
    expect(view.payload).toMatchObject({ container_id: "cn_t", kind: "chest", locked: false });
    expect(view.payload.items.map((i) => i.name)).toEqual(["Brass key"]);
    const diff = await t.b.wait("state_diff", (p) => p.containers_changed !== undefined, { from: mb });
    expect(diff.payload.containers_changed![0]).toMatchObject({ id: "cn_t", open: true, item_count: 1 });
    expect(t.b.all("container_view", mb)).toHaveLength(0);
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
    expect(t.a.invalid).toEqual([]);
  });

  it("a door opens with a state diff; reading a sign logs its text; examine is narrated without a model call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const { map } = stage(h, t);
    const before = provider.dmRequests().length;
    const mb = t.b.mark();
    t.a.send("act", { verb: "interact", target_id: "door_t" });
    const diff = await t.b.wait("state_diff", (p) => p.interactables_changed !== undefined, { from: mb });
    expect(diff.payload.interactables_changed).toEqual([{ map_id: map, id: "door_t", state: "open" }]);
    const ma = t.a.mark();
    t.a.send("act", { verb: "read", target_id: "sign_t" });
    await t.a.wait("log", (p) => p.kind === "engine" && p.text.includes("Mind the second step."), { from: ma });
    t.a.send("act", { verb: "examine", target_id: "chest_t" });
    await t.a.wait("log", (p) => p.kind === "narration" && /chest/i.test(p.text), { from: ma });
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
  });

  it("a refused verb is an error reply, and an altar is left to the DM", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    const r = await t.a.request("act", { verb: "pull", target_id: "door_t" });
    expect(r.type).toBe("error");
    const before = provider.dmRequests().length;
    const ok = await t.a.request("act", { verb: "interact", target_id: "altar_t" });
    expect(ok.type).not.toBe("error");
    await until(() => provider.dmRequests().length === before + 1);
    expect(provider.dmRequests().at(-1)!.messages[0]!.content).toContain("I interact with the altar");
  });
});

describe("container_action and inventory_action", () => {
  it("take moves the item to the pack, drop leaves a pile, give hands it to a neighbour", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const { pc } = stage(h, t);
    expect((await t.a.request("container_action", { verb: "take", container_id: "cn_t", item_id: "it_t1" })).type).not.toBe("error");
    expect(stateOf(h).characters[pc]!.inventory.map((i) => i.name)).toContain("Brass key");
    expect(stateOf(h).containers.cn_t!.items).toHaveLength(0);
    const mb = t.b.mark();
    expect((await t.a.request("inventory_action", { verb: "drop", item_id: "it_lamp" })).type).not.toBe("error");
    // an inventory change sends a fresh snapshot (it carries the containers); either way the pile shows up
    await t.b.waitMsg((m) => (m.type === "state_snapshot" && (m.payload.containers ?? []).some((c) => c.kind === "pile"))
      || (m.type === "state_diff" && (m.payload.containers_changed ?? []).some((c) => c.kind === "pile")), { from: mb });
    const other = Object.values(stateOf(h).characters).find((c) => c.id !== pc)!;
    const give = await t.a.request("inventory_action", { verb: "give", item_id: "it_t1", to_character_id: other.id });
    expect(give.type).not.toBe("error");
    expect(stateOf(h).characters[other.id]!.inventory.map((i) => i.name)).toContain("Brass key");
    expect((await t.a.request("inventory_action", { verb: "give", item_id: "it_t1", to_character_id: other.id })).type).toBe("error");
    const bad = await t.a.request("container_action", { verb: "take", container_id: "cn_t", item_id: "it_nope" });
    expect(bad.type).toBe("error");
  });
});

describe("typed commands skip the DM", () => {
  it("open the door, open the chest and take the key resolve in the engine with no model call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const { pc, map } = stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    say(t.a, "Open the door.");
    await until(() => effectiveState(stateOf(h!), map, findInteractable(stateOf(h!), map, "door_t")!) === "open");
    say(t.a, "open the chest");
    await until(() => stateOf(h!).containers.cn_t!.opened === true);
    say(t.a, "take the brass key");
    await until(() => stateOf(h!).characters[pc]!.inventory.some((i) => i.name === "Brass key"));
    await gameOf(h).idle();
    await sleep(150);
    expect(provider.dmRequests().length).toBe(before);
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/takes Brass key/);
  });

  it("an adverb or an unknown name still reaches the DM", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    stage(h, t);
    await gameOf(h).idle();
    const before = provider.dmRequests().length;
    say(t.a, "I carefully open the door while watching the hall");
    await until(() => provider.dmRequests().length === before + 1);
    expect(stateOf(h).containers.cn_t!.opened).not.toBe(true);
  });
});

describe("in combat", () => {
  const FOE: Enemy = {
    v: 1, name: "Robed Chorister", concept: "A cultist who borrows the voices of the drowned.", role: "standard",
    stats: { hp: 10, defense: 12, attack_bonus: 3, speed: 6, damage_dice: "1d6" },
    weakness: null, resistance: null, behavior: ["Closes to melee"], loot_hint: "", sprite_tags: ["robe"], abilities: [],
  };

  it("object verbs cost the action and only the active character may act", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const { map } = stage(h, t);
    let st = stateOf(h);
    const reg = registerArchetype(st, FOE);
    if (!reg.ok) throw new Error(reg.errors.join("; "));
    const m = st.maps[map]!;
    const at = findFreeTileNear(m, 1, 1, occupiedTiles(reg.state, map))!;
    const spawned = applyDmActions(reg.state, createRng(1), [{ type: "spawn_entity", archetype_id: reg.archetype.id as string, map_id: map, x: at.x, y: at.y, count: 1 }], {
      presentCharacterIds: Object.keys(st.characters), partyLevel: 1,
    });
    st = spawned.state;
    const foe = Object.values(st.entities).find((e) => e.kind === "enemy")!.id;
    const fight = startCombat(st, createRng(2), [...Object.keys(st.characters), foe], "standard");
    expect(fight.ok).toBe(true);
    gameOf(h).state = fight.state;
    const active = fight.state.combat!.active_id;
    const mine = stateOf(h).characters[t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id === t.a.playerId)!.id]!.id;
    const mover = active === mine ? t.a : t.b;
    const idle = active === mine ? t.b : t.a;
    // staged objects sit around A; put the active character beside the chest if it is B
    if (mover === t.b) {
      const next = cloneState(stateOf(h));
      const a = next.entities[mine]!;
      next.entities[active]!.x = a.x;
      next.entities[active]!.y = a.y + 2;
      gameOf(h).state = next;
    }
    expect((await idle.request("act", { verb: "open", target_id: "door_t" })).type).toBe("error");
    if (mover === t.a) {
      expect((await mover.request("act", { verb: "open", target_id: "door_t" })).type).not.toBe("error");
      expect(stateOf(h).combat!.turn.actionUsed).toBe(true);
      expect((await mover.request("act", { verb: "open", target_id: "chest_t" })).type).toBe("error"); // the action is spent
    }
  });
});
