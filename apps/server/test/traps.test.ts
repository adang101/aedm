import { afterEach, describe, expect, it } from "vitest";
import {
  addMap, applyDmActions, cloneState, createRng, designSpriteOffline, effectiveState, findInteractableAny, generateMap, isHidden, knownTrapTiles,
  objectKey, registerArchetype, STARTER_BRIEFS, trapBlockedText, type GameState,
} from "@aedm/engine";
import type { Enemy } from "@aedm/schemas";
import { dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type Table } from "./helpers";
import { gameOf, obj, stageRun, stateOf, trapObj, type Stage } from "./stage";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  expect(cond()).toBe(true);
}

const hiddenTrap = (id: string, x: number, y: number, dc = 20, dice = "2d6") => trapObj(id, x, y, { hidden: true, trap: { dc, dice, damage_type: "sharp" } });
const trapIn = (id: string) => (st: GameState, s: Stage) => findInteractableAny(st, s.mapId, id)!;
const armed = (id: string, s: Stage) => effectiveState(stateOf(h!), s.mapId, trapIn(id)(stateOf(h!), s)) === "closed";
const dms = (p: { dmRequests(): unknown[] }) => p.dmRequests().length;
const walk = (t: Table, x: number, y: number) => t.a.request("move_intent", { x, y });

describe("a hidden trap sprung on a walk", () => {
  it("stops the walk, reveals the trap as sprung, tells the table and the DM, and costs no model call", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [hiddenTrap("trap_x", g.x0 + 4, g.y)] });
    await gameOf(h).idle();
    const before = dms(provider);
    const ma = t.a.mark();
    const mb = t.b.mark();
    expect((await walk(t, s.x0 + 9, s.y)).type).not.toBe("error");
    await until(() => !armed("trap_x", s));
    await sleep(120);
    const pc = stateOf(h).entities[s.a]!;
    expect({ x: pc.x, y: pc.y }).toEqual({ x: s.x0 + 4, y: s.y }); // the walk ended on the trap
    expect(pc.hp).toBeLessThan(pc.hpMax);
    for (const c of [t.a, t.b]) {
      const from = c === t.a ? ma : mb;
      const diff = await c.wait("state_diff", (p) => p.interactables_revealed !== undefined, { from });
      expect(diff.payload.interactables_revealed).toEqual([{ map_id: s.mapId, object: { type: "interactable", id: "trap_x", kind: "trap", state: "open", x: s.x0 + 4, y: s.y } }]);
      await c.wait("log", (p) => p.kind === "engine" && /trips a hidden trap/.test(p.text), { from });
      expect(c.invalid).toEqual([]);
    }
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/sets off a trap at \(\d+,\d+\) and takes \d+ damage/);
    expect(dms(provider)).toBe(before);
  });

  it("does not stop a single directional step, even onto a known armed trap", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [trapObj("trap_x", g.x0 + 1, g.y)] });
    expect(knownTrapTiles(stateOf(h), s.mapId).has(`${s.x0 + 1},${s.y}`)).toBe(true);
    const r = await t.a.request("move_intent", { direction: "e" });
    expect(r.type).not.toBe("error");
    await until(() => !armed("trap_x", s));
    expect(stateOf(h).entities[s.a]!.x).toBe(s.x0 + 1);
  });
});

describe("passive spotting", () => {
  it("a trap noticed during a walk stops it short of the trap, and the next walk goes around", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [hiddenTrap("trap_x", g.x0 + 8, g.y, 10)] });
    await gameOf(h).idle();
    const before = dms(provider);
    const ma = t.a.mark();
    const hp = stateOf(h).entities[s.a]!.hp;
    expect((await walk(t, s.x0 + 12, s.y)).type).not.toBe("error");
    await until(() => !isHidden(stateOf(h!), s.mapId, trapIn("trap_x")(stateOf(h!), s)));
    await sleep(120);
    const stopped = stateOf(h).entities[s.a]!;
    expect(stopped.x).toBeLessThan(s.x0 + 8);
    expect(stopped.x).toBeGreaterThan(s.x0);
    expect(armed("trap_x", s)).toBe(true);
    const diff = await t.a.wait("state_diff", (p) => p.interactables_revealed !== undefined, { from: ma });
    expect(diff.payload.interactables_revealed![0]!.object).toMatchObject({ id: "trap_x", kind: "trap", state: "closed" });
    await t.a.wait("log", (p) => /notices a trap ahead/.test(p.text), { from: ma });
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/notices a trap at/);
    // the way is still open: the walk now goes around the revealed trap
    expect((await walk(t, s.x0 + 12, s.y)).type).not.toBe("error");
    await until(() => stateOf(h!).entities[s.a]!.x === s.x0 + 12);
    expect(armed("trap_x", s)).toBe(true);
    expect(stateOf(h).entities[s.a]!.hp).toBe(hp);
    expect(dms(provider)).toBe(before);
  });

  it("a trap too hard to notice stays hidden and does not stop a walk that is not on it", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [hiddenTrap("trap_x", g.x0 + 8, g.y - 1, 30)] });
    expect((await walk(t, s.x0 + 12, s.y + 1)).type).not.toBe("error");
    await until(() => stateOf(h!).entities[s.a]!.x === s.x0 + 12);
    expect(isHidden(stateOf(h), s.mapId, trapIn("trap_x")(stateOf(h), s))).toBe(true);
  });
});

describe("walk routing around known traps", () => {
  it("goes around a known armed trap whenever there is another way", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: (g) => [trapObj("trap_x", g.x0 + 4, g.y), trapObj("trap_y", g.x0 + 8, g.y)] });
    const hp = stateOf(h).entities[s.a]!.hp;
    expect((await walk(t, s.x0 + 12, s.y)).type).not.toBe("error");
    await until(() => stateOf(h!).entities[s.a]!.x === s.x0 + 12);
    expect(armed("trap_x", s) && armed("trap_y", s)).toBe(true);
    expect(stateOf(h).entities[s.a]!.hp).toBe(hp);
  });

  it("refuses a walk whose only way crosses a known trap, and moves nobody", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { seal: true, objects: (g) => [trapObj("trap_x", g.x0 + 5, g.y)] });
    const r = await walk(t, s.x0 + 9, s.y);
    expect(r.type).toBe("error");
    expect(JSON.stringify(r.payload)).toContain(trapBlockedText());
    await sleep(100);
    expect(stateOf(h).entities[s.a]!.x).toBe(s.x0);
    expect(armed("trap_x", s)).toBe(true);
  });

  it("walks onto the trap when the clicked tile is the trap itself", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { seal: true, objects: (g) => [trapObj("trap_x", g.x0 + 5, g.y)] });
    expect((await walk(t, s.x0 + 5, s.y)).type).not.toBe("error");
    await until(() => !armed("trap_x", s));
    expect(stateOf(h).entities[s.a]!.x).toBe(s.x0 + 5);
  });

  it("refuses a typed walk to an object when only a known trap is in the way, and tells the player", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, { seal: true, objects: (g) => [trapObj("trap_x", g.x0 + 5, g.y), obj({ id: "lever_t", kind: "lever", state: "closed", x: g.x0 + 9, y: g.y })] });
    await gameOf(h).idle();
    const mark = t.a.mark();
    t.a.send("say", { text: "go to the lever", channel: "ic" });
    await t.a.wait("log", (p) => p.text === trapBlockedText(), { from: mark });
    await sleep(100);
    expect(stateOf(h).entities[s.a]!.x).toBe(s.x0);
    expect(armed("trap_x", s)).toBe(true);
  });

  it("a walk stops before a trap that is found after it began", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { seal: true, objects: (g) => [hiddenTrap("trap_x", g.x0 + 9, g.y, 30)] });
    // slow the walk so the trap can be revealed in between
    (gameOf(h) as unknown as { cfg: { moveStepMs: number } }).cfg.moveStepMs = 60;
    expect((await walk(t, s.x0 + 12, s.y)).type).not.toBe("error");
    await sleep(70);
    const st = cloneState(stateOf(h));
    st.interactables[objectKey(s.mapId, "trap_x")] = { revealed: true };
    gameOf(h).state = st;
    await sleep(900);
    expect(stateOf(h).entities[s.a]!.x).toBeLessThan(s.x0 + 9);
    expect(armed("trap_x", s)).toBe(true);
  });
});

describe("a trap that downs a hero outside combat", () => {
  const huge = (g: Stage) => [trapObj("trap_x", g.x0 + 1, g.y, { trap: { dc: 30, dice: "8d12", damage_type: "sharp" } })];

  it("wakes the whole party at 1 HP when nobody is left standing, so play cannot dead-end", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stageRun(h, t, {
      objects: huge,
      edit: (st, g) => { const b = st.entities[g.b]!; b.hp = 0; b.conditions = [{ condition: "prone", turns: 99 }]; },
    });
    await gameOf(h).idle();
    const ma = t.a.mark();
    expect((await t.a.request("move_intent", { direction: "e" })).type).not.toBe("error");
    await until(() => !armed("trap_x", s));
    await until(() => stateOf(h!).entities[s.a]!.hp === 1 && stateOf(h!).entities[s.b]!.hp === 1);
    for (const id of [s.a, s.b]) expect(stateOf(h).entities[id]!.conditions.some((c) => c.condition === "prone")).toBe(false);
    await t.a.wait("log", (p) => /wakes at 1 HP/.test(p.text), { from: ma });
    expect(gameOf(h).pendingEngineLines.join(" ")).toMatch(/every hero was down outside combat/);
    // and they can act again
    const r = await t.a.request("move_intent", { direction: "e" });
    expect(r.type).not.toBe("error");
  });

  it("leaves a downed hero down while a friend still stands (existing rule: healing, a revive or a scene change brings them back)", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, { objects: huge });
    expect((await t.a.request("move_intent", { direction: "e" })).type).not.toBe("error");
    await until(() => stateOf(h!).entities[s.a]!.hp === 0);
    await sleep(100);
    expect(stateOf(h).entities[s.a]!.hp).toBe(0);
    expect(stateOf(h).entities[s.b]!.hp).toBeGreaterThan(0);
    expect((await t.a.request("move_intent", { direction: "e" })).type).toBe("error"); // down: cannot move
  });
});

describe("a trap sprung in combat", () => {
  const RAT: Enemy = {
    v: 1, name: "Marsh Rat", concept: "A marsh rat", role: "minion",
    stats: { hp: 4, defense: 10, attack_bonus: 1, speed: 6, damage_dice: "1d4" },
    weakness: null, resistance: null, behavior: ["Closes to melee"], loot_hint: "", sprite_tags: [], abilities: [],
  };

  it("stops that move and hurts, the turn carries on, and ending it passes the turn", async () => {
    h = await startHarness({ provider: scriptedProvider(), random: () => 0.5 });
    const t = await startedTable(h);
    const s = stageRun(h, t, {
      objects: (g) => [hiddenTrap("trap_a", g.x0 + 2, g.y), hiddenTrap("trap_b", g.x0 + 2, g.y - 1)],
      edit: (st, g) => {
        const reg = registerArchetype(st, RAT);
        if (!reg.ok) throw new Error(reg.errors.join("; "));
        Object.assign(st, reg.state);
        st.entities.ei_rat = {
          id: "ei_rat", kind: "enemy", name: "Marsh Rat", mapId: g.mapId, x: g.x0 + 13, y: g.y, hp: 4, hpMax: 4, conditions: [], shield: 0,
          sprite: designSpriteOffline({ concept: "a marsh rat", name: "Marsh Rat", role: "minion", kind: "enemy" }, 3),
          refId: reg.archetype.id as string, disposition: "hostile", cooldowns: {}, usesLeft: {}, checkBonuses: [],
        };
      },
    });
    const game = gameOf(h);
    expect(game.engageEnemy(s.a, "ei_rat")).toBe(true);
    const isPc = (id: string) => id === s.a || id === s.b;
    await until(() => !!stateOf(h!).combat && isPc(stateOf(h!).combat!.active_id));
    const active = stateOf(h).combat!.active_id;
    const client = active === s.a ? t.a : t.b;
    const e0 = stateOf(h).entities[active]!;
    const mark = client.mark();
    const r = await client.request("move_intent", { x: e0.x + 4, y: e0.y });
    expect(r.type).not.toBe("error");
    await until(() => stateOf(h!).entities[active]!.hp < e0.hp);
    const e1 = stateOf(h).entities[active]!;
    expect(e1.x).toBe(e0.x + 2); // stopped on the trap
    expect(stateOf(h).combat!.active_id).toBe(active); // it is still their turn
    const diff = await client.wait("state_diff", (p) => p.interactables_revealed !== undefined, { from: mark });
    expect(diff.payload.interactables_revealed![0]!.object).toMatchObject({ kind: "trap", state: "open" });
    expect(client.invalid).toEqual([]);
    const end = await client.request("end_turn", {});
    expect(end.type).not.toBe("error");
    await until(() => stateOf(h!).combat?.active_id !== active || stateOf(h!).combat === null);
  });
});

describe("allies and known traps", () => {
  it("a following ally keeps off a known armed trap when a way around exists", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stageRun(h, t, {
      objects: (g) => [trapObj("trap_x", g.x0 + 8, g.y), trapObj("trap_y", g.x0 + 7, g.y)],
      edit: (st, g) => {
        const r = applyDmActions(st, createRng(3), [{ type: "create_npc", name: "Odalys", concept: "A local.", role: "ally", map_id: g.mapId, x: g.x0 + 10, y: g.y, sprite_tags: ["coat"] }], { presentCharacterIds: [g.a, g.b], partyLevel: 1 });
        if (r.rejected.length > 0) throw new Error(r.rejected.map((x) => x.reason).join("; "));
        Object.assign(st, r.state);
      },
    });
    const ally = Object.values(stateOf(h).npcs).find((n) => n.name === "Odalys")!.id;
    const trapTiles = knownTrapTiles(stateOf(h), s.mapId);
    expect(trapTiles.size).toBe(2);
    for (let i = 0; i < 5; i++) {
      const r = await t.a.request("move_intent", { direction: i % 2 === 0 ? "s" : "n" });
      expect(r.type).not.toBe("error");
      await sleep(40);
      const at = stateOf(h).entities[ally]!;
      expect(trapTiles.has(`${at.x},${at.y}`), `step ${i}`).toBe(false);
    }
    expect(stateOf(h).entities[ally]!.x).toBeLessThan(s.x0 + 10); // it did follow
    expect(armed("trap_x", s) && armed("trap_y", s)).toBe(true);
  });
});

describe("scene changes", () => {
  it("a trap the party can see on arrival is revealed, and the clients are told", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const game = gameOf(h);
    const st = cloneState(game.state);
    const gen = generateMap(STARTER_BRIEFS.town, { seed: 11, id: "m_next" }).map;
    const withTrap = structuredClone(gen);
    const spawnObj = withTrap.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).find((o) => o.type === "spawn" && o.name === "party_start")!;
    for (const l of withTrap.layers) {
      if (l.type !== "objectgroup") continue;
      l.objects = l.objects.filter((o) => !(o.type === "interactable" && o.kind === "trap"));
      // two tiles beside the spawn; walkable or not, a trap there is within sight and its DC is low
      l.objects.push(trapObj("trap_arr", spawnObj.x + 3, spawnObj.y, { hidden: true, trap: { dc: 5, dice: "1d6", damage_type: "sharp" } }));
    }
    Object.assign(st, addMap(st, withTrap).state);
    game.state = st;
    const mark = t.a.mark();
    provider.queueDm(dmReply([{ type: "change_scene", map_id: "m_next", entry: "party_start" }]));
    t.a.send("say", { text: "We move on.", channel: "ic" });
    t.b.send("say", { text: "Agreed.", channel: "ic" });
    await until(() => stateOf(h!).currentMapId === "m_next");
    await gameOf(h).idle();
    expect(isHidden(stateOf(h), "m_next", findInteractableAny(stateOf(h), "m_next", "trap_arr")!)).toBe(false);
    const told = t.a.msgs.slice(mark).some((m) =>
      (m.type === "state_diff" && (m.payload.interactables_revealed ?? []).some((r) => r.object.id === "trap_arr"))
      || (m.type === "state_snapshot" && JSON.stringify(m.payload.map).includes("trap_arr")));
    expect(told).toBe(true);
  });
});
