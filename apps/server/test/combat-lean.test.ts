import { afterEach, describe, expect, it } from "vitest";
import { cloneState, designSpriteOffline, findFreeTileNear, occupiedTiles, registerArchetype, type EngineEvent, type GameState } from "@aedm/engine";
import type { Enemy, EntityView } from "@aedm/schemas";
import { dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type Scripted, type Table } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

type Game = ReturnType<typeof gameOf>;
const gameOf = (harness: Harness) => harness.server.rooms.all()[0]!.game!;
const priv = (g: Game) => g as unknown as {
  commit(s: GameState): void;
  publish(events: EngineEvent[]): string[];
  advanceCombat(): Promise<void>;
};

const enemyDef = (name: string, role: Enemy["role"], hp: number): Enemy => ({
  v: 1, name, concept: `A ${name.toLowerCase()}`, role,
  stats: { hp, defense: 10, attack_bonus: 1, speed: 6, damage_dice: "1d4" },
  weakness: null, resistance: null, behavior: ["Closes to melee"], loot_hint: "", sprite_tags: [], abilities: [],
});

interface Foe { id: string; name: string }

/** Put hostile creatures on the party's map through plain state edits (no DM call). */
function addFoes(g: Game, specs: { name: string; role: Enemy["role"]; hp?: number; concept?: string }[]): Foe[] {
  let state = cloneState(g.state);
  const mapId = state.currentMapId!;
  const anchor = Object.values(state.entities).find((e) => e.kind === "pc")!;
  const foes: Foe[] = [];
  specs.forEach((spec, i) => {
    const reg = registerArchetype(state, enemyDef(spec.name, spec.role, spec.hp ?? 6));
    if (!reg.ok) throw new Error(reg.errors.join("; "));
    state = reg.state;
    const spot = findFreeTileNear(state.maps[mapId]!, anchor.x + 3, anchor.y + i, occupiedTiles(state, mapId))!;
    const id = `ei_t${i}`;
    state.entities[id] = {
      id, kind: "enemy", name: spec.name, mapId, x: spot.x, y: spot.y, hp: spec.hp ?? 6, hpMax: spec.hp ?? 6, conditions: [], shield: 0,
      sprite: designSpriteOffline({ concept: spec.concept ?? "a hooded cultist", name: spec.name, role: spec.role, kind: "enemy" }, 3),
      refId: reg.archetype.id as string, disposition: "hostile", cooldowns: {}, usesLeft: {}, checkBonuses: [],
    };
    foes.push({ id, name: spec.name });
  });
  priv(g).commit(state);
  return foes;
}

function drop(g: Game, id: string, how: "defeated" | "fled"): EngineEvent[] {
  const next = cloneState(g.state);
  const name = next.entities[id]!.name;
  if (how === "defeated") next.entities[id]!.hp = 0;
  else {
    delete next.entities[id];
    next.combat!.order = next.combat!.order.filter((o) => o.entity_id !== id);
    if (next.combat!.cursor >= next.combat!.order.length) next.combat!.cursor = 0;
  }
  priv(g).commit(next);
  const events: EngineEvent[] = how === "defeated" ? [{ type: "defeated", entityId: id, entityName: name }] : [{ type: "fled", entityId: id, name }];
  priv(g).publish(events);
  return events;
}

async function setup(provider: Scripted, config: Record<string, unknown> = {}) {
  h = await startHarness({ provider, config: config as never, random: () => 0.5 });
  const t = await startedTable(h);
  const g = gameOf(h);
  const snap = t.a.lastSnapshot()!;
  const pcs = snap.entities.filter((e) => e.kind === "pc") as EntityView[];
  return { t, g, pcs };
}

/** Wait until a player's turn is up (the engine has run any enemy turns before it). */
async function waitForPlayerTurn(t: Table, from: number) {
  return t.a.wait("turn_timer", () => true, { from });
}

const dmCount = (p: Scripted) => p.dmRequests().length;

describe("lean combat", () => {
  it("an attack on a hostile enemy starts the fight in the engine, and a won ordinary fight makes zero DM calls", async () => {
    const provider = scriptedProvider();
    const { t, g, pcs } = await setup(provider);
    const foes = addFoes(g, [
      { name: "Marsh Rat", role: "minion", hp: 4, concept: "a marsh rat" }, { name: "Marsh Rat", role: "minion", hp: 4, concept: "a marsh rat" },
      { name: "Marsh Rat", role: "minion", hp: 4, concept: "a marsh rat" }, { name: "Hollow Guard", role: "standard", hp: 8 },
    ]);
    await g.idle();
    const before = dmCount(provider);
    const mark = t.a.mark();
    const reply = await t.a.request("basic_attack", { target_id: foes[0]!.id });
    expect(reply.type).not.toBe("error");
    await t.a.wait("combat_state", () => true, { from: mark });
    const open = await t.a.wait("narration_chunk", (c) => c.done && c.text.includes("Marsh Rat"), { from: mark });
    expect(open.payload.text).toContain("Marsh Rat (x3)");
    expect(open.payload.text).toContain("Hollow Guard");
    const order = g.state.combat!.order.map((o) => o.entity_id);
    expect(order).toEqual(expect.arrayContaining([...pcs.map((p) => p.id), ...foes.map((f) => f.id)]));
    await waitForPlayerTurn(t, mark);
    await g.idle();
    expect(g.pendingEngineLines.join("\n")).toContain("the engine started the fight without the DM");

    // a minion's nerve breaks and another runs: engine barks, no model call
    const chatMark = t.a.mark();
    const m2 = t.a.mark();
    priv(g).publish([{ type: "morale_broken", entityId: foes[1]!.id, name: foes[1]!.name, reason: "hurt" }]);
    drop(g, foes[1]!.id, "fled");
    drop(g, foes[0]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    await sleep(80); // let the websocket deliver
    // rats cannot talk: their reactions arrive as narration naming them
    const barks = t.a.all("narration_chunk", chatMark).filter((c) => c.payload.text.includes("Marsh Rat"));
    expect(barks.length).toBeGreaterThanOrEqual(1);
    expect(dmCount(provider)).toBe(before);
    expect(g.state.combat).not.toBeNull();

    // the rest fall: victory, closed by the engine
    drop(g, foes[2]!.id, "defeated");
    drop(g, foes[3]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(g.state.combat).toBeNull();
    expect(dmCount(provider)).toBe(before);
    await sleep(80);
    const closing = t.a.all("narration_chunk", m2).filter((c) => c.payload.done).map((c) => c.payload.text);
    expect(closing.at(-1)).toMatch(/foe|enemy|silence|fight/i);
    expect(g.pendingEngineLines.join("\n")).toContain("the engine narrated the close without the DM");
    expect(t.a.invalid).toEqual([]);

    // the next DM call sees all of it
    provider.queueDm(dmReply());
    t.a.send("say", { text: "We rest a moment.", channel: "ic" });
    t.b.send("say", { text: "Same.", channel: "ic" });
    for (let i = 0; i < 100 && dmCount(provider) === before; i++) await sleep(20);
    const next = provider.dmRequests().at(-1)!.messages[0]!.content;
    expect(next).toContain("the engine started the fight without the DM");
    expect(next).toContain("the engine narrated the close without the DM");
  });

  it("a spoken bark is remembered by a surrendered creature through the engine's npc_say", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }, { name: "Marsh Rat", role: "minion", hp: 4 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    // the guard yields: the engine turns it into a wary NPC with a dossier
    const next = cloneState(g.state);
    const ent = next.entities[foes[0]!.id]!;
    next.npcs[ent.id] = { id: ent.id, name: ent.name, concept: "a guard", role: "bystander", map_id: ent.mapId, x: ent.x, y: ent.y, sprite_tags: [], disposition: "wary", alive: true, last_seen_beat: 0 } as never;
    Object.assign(ent, { kind: "npc", disposition: "wary", refId: ent.id });
    next.combat!.order = next.combat!.order.filter((o) => o.entity_id !== ent.id);
    if (next.combat!.cursor >= next.combat!.order.length) next.combat!.cursor = 0;
    priv(g).commit(next);
    priv(g).publish([{ type: "surrendered", entityId: ent.id, name: ent.name, npcId: ent.id }]);
    const before = dmCount(provider);
    const m2 = t.a.mark();
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    await sleep(80);
    const said = t.a.all("chat", m2).find((c) => c.payload.from_id === ent.id);
    expect(said).toBeTruthy();
    expect(g.state.npcs[ent.id]!.lines).toContain(said!.payload.text);
    expect(dmCount(provider)).toBe(before);
  });

  it("a humanoid that flees after leaving the scene still gets its spoken line to the table", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }, { name: "Hollow Archer", role: "standard", hp: 8 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const before = dmCount(provider);
    const m2 = t.a.mark();
    drop(g, foes[0]!.id, "fled");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    const said = await t.a.wait("chat", (c) => c.from_id === foes[0]!.id, { from: m2 });
    expect(said.payload.text.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(provider.dmRequests().length).toBe(before);
    // the DM's next call sees the line among the recent turns
    expect(JSON.stringify((g as unknown as { recent: unknown[] }).recent)).toContain(said.payload.text);
  });

  it("a creature that cannot talk emotes as narration", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Marsh Hound", role: "standard", hp: 8, concept: "a snarling marsh hound beast" }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const m2 = t.a.mark();
    priv(g).publish([{ type: "surrendered", entityId: foes[0]!.id, name: "Marsh Hound" }]);
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    await sleep(80);
    const lines = t.a.all("narration_chunk", m2).map((c) => c.payload.text);
    expect(lines.some((l) => l.includes("Marsh Hound"))).toBe(true);
    expect(t.a.all("chat", m2).filter((c) => c.payload.from_id === foes[0]!.id)).toEqual([]);
  });

  it("a fight with a boss still gets the DM at the end (one call)", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Marsh Rat", role: "minion", hp: 4 }, { name: "Drowned Warden", role: "boss", hp: 20 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const before = dmCount(provider);
    drop(g, foes[0]!.id, "defeated");
    drop(g, foes[1]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(g.state.combat).toBeNull();
    expect(dmCount(provider) - before).toBe(1);
  });

  it("an elite that fled still counts: the DM closes the fight", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Marsh Rat", role: "minion", hp: 4 }, { name: "Gate Captain", role: "elite", hp: 12 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const before = dmCount(provider);
    drop(g, foes[1]!.id, "fled");
    drop(g, foes[0]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(dmCount(provider) - before).toBe(1);
  });

  it("a hero dropping to 0 HP is a dramatic beat and still earns a DM reaction", async () => {
    const provider = scriptedProvider();
    const { t, g, pcs } = await setup(provider);
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const before = dmCount(provider);
    priv(g).publish([{ type: "downed", entityId: pcs[0]!.id, entityName: pcs[0]!.name }]);
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(dmCount(provider) - before).toBe(1);
  });

  it("player speech mid-fight still gets a DM answer", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const before = dmCount(provider);
    provider.queueDm(dmReply([{ type: "npc_say", entity_id: foes[0]!.id, text: "Your courage will drown with you." }]));
    const m2 = t.a.mark();
    t.a.send("say", { text: "Hold the line, I will draw them off!", channel: "ic" });
    const chat = await t.a.wait("chat", (c) => c.from_id === foes[0]!.id, { from: m2 });
    expect(chat.payload.text).toBe("Your courage will drown with you.");
    await g.idle();
    expect(provider.dmRequests().slice(before).filter((r) => r.messages[0]!.content.includes("Hold the line"))).toHaveLength(1);
  });

  it("a victory with queued player speech goes to the DM", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider);
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const before = dmCount(provider);
    // speech is queued, then the last foe falls before the loop runs
    (g as unknown as { combatIntents: unknown[] }).combatIntents.push({ characterId: "x", characterName: "Brindle Ash", text: "Well fought!" });
    drop(g, foes[0]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(dmCount(provider) - before).toBe(1);
  });

  it("defeat always goes to the DM", async () => {
    const provider = scriptedProvider();
    const { t, g, pcs } = await setup(provider);
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }]);
    await g.idle();
    const mark = t.a.mark();
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    const next = cloneState(g.state);
    for (const p of pcs) next.entities[p.id]!.hp = 0;
    priv(g).commit(next);
    const before = dmCount(provider);
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(dmCount(provider) - before).toBeGreaterThanOrEqual(1);
  });

  it("engageEnemy refuses non-enemies and changes nothing", async () => {
    const provider = scriptedProvider();
    const { g, pcs } = await setup(provider);
    const [a, b] = pcs as [EntityView, EntityView];
    expect(g.engageEnemy(a.id, b.id)).toBe(false);
    expect(g.engageEnemy(a.id, "nope")).toBe(false);
    expect(g.engageEnemy("nope", a.id)).toBe(false);
    expect(g.state.combat).toBeNull();
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }]);
    const asNpc = cloneState(g.state);
    asNpc.entities[foes[0]!.id]!.kind = "npc";
    priv(g).commit(asNpc);
    expect(g.engageEnemy(a.id, foes[0]!.id)).toBe(false);
    expect(g.state.combat).toBeNull();
  });
});

describe("combat DM calls, before and after", () => {
  /** 3 minions and a standard enemy; one minion breaks and flees, one falls, then the rest fall. Returns the DM calls made. */
  async function typicalFight(mode: "lean" | "full"): Promise<number> {
    const provider = scriptedProvider();
    const { t, g, pcs } = await setup(provider, { combatDm: mode });
    const foes = addFoes(g, [
      { name: "Marsh Rat", role: "minion", hp: 4, concept: "a marsh rat" }, { name: "Marsh Rat", role: "minion", hp: 4, concept: "a marsh rat" },
      { name: "Marsh Rat", role: "minion", hp: 4, concept: "a marsh rat" }, { name: "Hollow Guard", role: "standard", hp: 8 },
    ]);
    await g.idle();
    const before = dmCount(provider);
    const mark = t.a.mark();
    if (mode === "lean") {
      await t.a.request("basic_attack", { target_id: foes[0]!.id });
    } else {
      provider.queueDm(dmReply([{ type: "start_combat", participants: [...pcs.map((p) => p.id), ...foes.map((f) => f.id)], difficulty: "hard" }]));
      t.a.send("say", { text: "I attack the rats!", channel: "ic" });
      t.b.send("say", { text: "I draw my weapon.", channel: "ic" });
    }
    await t.a.wait("combat_state", () => true, { from: mark });
    await waitForPlayerTurn(t, mark);
    await g.idle();
    priv(g).publish([{ type: "morale_broken", entityId: foes[1]!.id, name: "Marsh Rat", reason: "hurt" }]);
    drop(g, foes[1]!.id, "fled");
    drop(g, foes[0]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    drop(g, foes[2]!.id, "defeated");
    drop(g, foes[3]!.id, "defeated");
    await g.enqueue(() => priv(g).advanceCombat());
    await g.idle();
    expect(g.state.combat).toBeNull();
    return dmCount(provider) - before;
  }

  it("lean: 0 DM calls; full: start, one reaction and the close", async () => {
    const lean = await typicalFight("lean");
    await h?.stop(); h = undefined;
    const full = await typicalFight("full");
    console.log(`DM calls for 3 minions + 1 standard (one flees): lean=${lean}, full=${full}`);
    expect(lean).toBe(0);
    expect(full).toBe(3);
  });

  it("full mode: the attack button is only an intent for the DM and no engine fight starts", async () => {
    const provider = scriptedProvider();
    const { t, g } = await setup(provider, { combatDm: "full" });
    const foes = addFoes(g, [{ name: "Hollow Guard", role: "standard", hp: 8 }]);
    await g.idle();
    const before = dmCount(provider);
    expect(g.engageEnemy(g.state.combat ? "" : Object.keys(g.state.characters)[0]!, foes[0]!.id)).toBe(false);
    await t.a.request("basic_attack", { target_id: foes[0]!.id });
    expect(g.state.combat).toBeNull(); // the engine did not start anything; the attack waits for the DM
    t.b.send("say", { text: "I watch.", channel: "ic" });
    for (let i = 0; i < 100 && dmCount(provider) === before; i++) await sleep(20);
    expect(dmCount(provider) - before).toBe(1);
    expect(provider.dmRequests().at(-1)!.messages[0]!.content).toContain("I attack Hollow Guard");
  });
});
