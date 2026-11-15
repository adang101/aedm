import { afterEach, describe, expect, it } from "vitest";
import { findInteractableAny, isHidden, objectKey, cloneState } from "@aedm/engine";
import { createFakeProvider } from "@aedm/llm";
import { dmReply, scriptedProvider, sleep, startedTable, startHarness, type Harness, type TestClient } from "./helpers";
import { gameOf, obj, resend, stageRun, stateOf, trapObj, wire, type Stage } from "./stage";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i++) await sleep(10);
  expect(cond()).toBe(true);
}

/** A fake DM that says something harmless unless a reply is queued (the offline DM would build new maps and move the party away). */
function quietDm() {
  const queue: string[] = [];
  const improv = createFakeProvider();
  const p = createFakeProvider(async (req) => (req.purpose === "dm" ? queue.shift() ?? dmReply() : (await improv.complete(req)).text)) as ReturnType<typeof createFakeProvider> & { queueDm(...r: string[]): void; dmRequests(): unknown[] };
  p.queueDm = (...r) => { queue.push(...r); };
  p.dmRequests = () => (p as unknown as { requests: { purpose: string }[] }).requests.filter((r) => r.purpose === "dm");
  return p;
}

const SECRETS = ["trap_secret", "chest_secret", "cn_secret", "Secret hoard"];

/** A trap nobody can notice and a hidden chest, on the row above the strip the characters walk along. */
function stage(harness: Harness, t: Parameters<typeof stageRun>[1]): Stage {
  return stageRun(harness, t, {
    objects: (g) => [
      trapObj("trap_secret", g.x0 + 6, g.y - 1, { hidden: true, trap: { dc: 30, dice: "1d6", damage_type: "sharp" } }),
      obj({ id: "chest_secret", kind: "chest", state: "closed", hidden: true, x: g.x0 + 8, y: g.y - 1 }),
    ],
    edit: (st, g) => {
      st.containers.cn_secret = { v: 1, id: "cn_secret", kind: "chest", map_id: g.mapId, x: g.x0 + 8, y: g.y - 1, label: "Chest", object_id: "chest_secret", items: [{ id: "it_secret", name: "Secret hoard", kind: "trinket", value: 1 }] };
    },
  });
}

/** Everything structural a client could draw: map objects and container summaries of every snapshot and diff it got. */
function drawn(c: TestClient): { ids: string[]; spots: Set<string> } {
  const ids: string[] = [];
  const spots = new Set<string>();
  const addObj = (o: { id?: string; x?: number; y?: number }) => { if (o.id) ids.push(o.id); if (o.x !== undefined) spots.add(`${o.x},${o.y}`); };
  for (const m of c.msgs) {
    if (m.type === "state_snapshot") {
      for (const l of m.payload.map.layers) if (l.type === "objectgroup") for (const o of l.objects) addObj(o as { id?: string; x?: number; y?: number });
      for (const cn of m.payload.containers ?? []) { ids.push(cn.id); spots.add(`${cn.x},${cn.y}`); }
    } else if (m.type === "state_diff") {
      for (const cn of m.payload.containers_changed ?? []) { ids.push(cn.id); spots.add(`${cn.x},${cn.y}`); }
      for (const i of m.payload.interactables_changed ?? []) ids.push(i.id);
      for (const r of m.payload.interactables_revealed ?? []) addObj(r.object as { id?: string; x?: number; y?: number });
    }
  }
  return { ids, spots };
}

describe("hidden objects never reach a client before they are found", () => {
  it("not in a snapshot, a reconnect, a walk, a look, any refused command or a DM action on them", async () => {
    const provider = quietDm();
    h = await startHarness({ provider });
    const t = await startedTable(h);
    const s = stage(h, t);
    await gameOf(h).idle();
    const trapSpot = `${s.x0 + 6},${s.y - 1}`;
    const chestSpot = `${s.x0 + 8},${s.y - 1}`;
    const ma = t.a.mark();
    const mb = t.b.mark();

    // snapshots to everyone and to a reconnecting player
    resend(h);
    gameOf(h).sendFullState(t.a.playerId);
    // a walk beside them (the second leg runs along the row below, so it never touches them)
    expect((await t.a.request("move_intent", { x: s.x0, y: s.y + 1 })).type).not.toBe("error");
    await until(() => stateOf(h!).entities[s.a]!.y === s.y + 1);
    expect((await t.a.request("move_intent", { x: s.x0 + 12, y: s.y + 1 })).type).not.toBe("error");
    await until(() => stateOf(h!).entities[s.a]!.x === s.x0 + 12);
    // commands that name them are refused as if they did not exist
    for (const [verb, target] of [["examine", "trap_secret"], ["interact", "chest_secret"], ["open", "chest_secret"], ["open", "cn_secret"], ["disarm", "trap_secret"], ["pick_lock", "chest_secret"], ["examine", "cn_secret"]] as const) {
      const r = await t.a.request("act", { verb, target_id: target });
      expect(r.type, `${verb} ${target}`).toBe("error");
      expect(JSON.stringify(r)).not.toMatch(/secret/);
    }
    for (const verb of ["open", "take_all"] as const) {
      const r = await t.a.request("container_action", { verb, container_id: "cn_secret" });
      expect(r.type, verb).toBe("error");
      expect(JSON.stringify(r)).not.toMatch(/secret/);
    }
    expect((await t.a.request("container_action", { verb: "take", container_id: "cn_secret", item_id: "it_secret" })).type).toBe("error");
    // typed commands and a look
    let asked = provider.dmRequests().length;
    for (const text of ["look around", "walk to the trap", "open the chest", "examine the trap"]) {
      t.a.send("say", { text, channel: "ic" });
      t.b.send("say", { text: "ok", channel: "ic" });
      await gameOf(h).idle();
      await sleep(80);
      // the router cannot resolve a name that is not in the scene, so the words go to the DM (a hidden object is not walkable-to or openable by name)
      if (text !== "look around") expect(provider.dmRequests().length, text).toBeGreaterThan(asked);
      asked = provider.dmRequests().length;
    }
    expect(stateOf(h).entities[s.a]!.x).toBe(s.x0 + 12);
    // the DM stocks and locks the hidden chest: legal, and it reveals nothing
    provider.queueDm(dmReply([
      { type: "stock_container", container_id: "chest_secret", items: [{ name: "Brass coin", kind: "trinket", value: 1 }] },
      { type: "set_lock", target_id: "chest_secret", dc: 12 },
    ]));
    t.a.send("say", { text: "We wait a moment.", channel: "ic" });
    t.b.send("say", { text: "Sure.", channel: "ic" });
    await until(() => stateOf(h!).containers.cn_secret!.items.some((i) => i.name === "Brass coin"));
    await gameOf(h).idle();
    expect(stateOf(h).containers.cn_secret!.locked).toBe(true);

    for (const [c, from] of [[t.a, ma], [t.b, mb]] as const) {
      const text = wire(c, from);
      for (const secret of SECRETS) expect(text, `${secret} on the wire`).not.toContain(secret);
      expect(text).not.toContain("Brass coin");
      const { ids, spots } = drawn(c);
      for (const secret of SECRETS) expect(ids).not.toContain(secret);
      expect(spots.has(trapSpot)).toBe(false);
      expect(spots.has(chestSpot)).toBe(false);
      expect(c.invalid).toEqual([]);
    }
    // the live snapshot too
    const snap = JSON.stringify(t.a.lastSnapshot());
    for (const secret of SECRETS) expect(snap).not.toContain(secret);
    // ... and the trap is still armed and hidden: nothing above revealed it
    expect(isHidden(stateOf(h), s.mapId, findInteractableAny(stateOf(h), s.mapId, "trap_secret")!)).toBe(true);
  }, 30_000);

  it("once found, a fresh snapshot carries the objects, with nothing secret about them", async () => {
    h = await startHarness({ provider: scriptedProvider() });
    const t = await startedTable(h);
    const s = stage(h, t);
    const game = gameOf(h);
    const mb = t.b.mark();
    const st = cloneState(game.state);
    st.interactables[objectKey(s.mapId, "trap_secret")] = { revealed: true };
    st.interactables[objectKey(s.mapId, "chest_secret")] = { revealed: true };
    game.state = cloneState(st);
    resend(h);
    const snap = await t.b.wait("state_snapshot", (p) => JSON.stringify(p.map).includes("trap_secret"), { from: mb });
    expect(JSON.stringify(snap.payload.map)).toContain("chest_secret");
    expect((snap.payload.containers ?? []).map((c) => c.id)).toContain("cn_secret");
    expect(JSON.stringify(snap.payload)).not.toMatch(/"hidden"|"trap":|Secret hoard/);
  });
});
