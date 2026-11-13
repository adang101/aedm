import { afterEach, describe, expect, it } from "vitest";
import { abilityCost, levelCaps, isWalkable, validateMap } from "@aedm/engine";
import { brindle, lobbyOfTwo, startHarness, startedTable, scriptedProvider, tamsin, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

describe("rooms and lobby", () => {
  it("create_room then join_room gives joined + lobby_state; a second player joins by code; a bad code errors", async () => {
    h = await startHarness();
    const a = await h.connect();
    const created = await a.request("create_room", { display_name: "Alice" });
    expect(created.type).toBe("room_created");
    if (created.type !== "room_created") return;
    expect(created.payload.invite_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);

    const joined = await a.join(created.payload.invite_code, "Alice");
    expect(joined.type).toBe("joined");
    const lobby = await a.wait("lobby_state");
    expect(lobby.payload.host_player_id).toBe(a.playerId);
    expect(lobby.payload.phase).toBe("lobby");
    expect(lobby.payload.players).toHaveLength(1);

    const b = await h.connect();
    const bj = await b.join(created.payload.invite_code.toLowerCase(), "Bob");
    expect(bj.type).toBe("joined");
    const both = await a.wait("lobby_state", (p) => p.players.length === 2);
    expect(both.payload.players.map((p) => p.display_name)).toEqual(["Alice", "Bob"]);

    const c = await h.connect();
    const bad = await c.join("ZZZZZZ", "Carol");
    expect(bad.type).toBe("error");
    if (bad.type === "error") expect(bad.payload.code).toBe("not_found");
    expect([a, b, c].flatMap((x) => x.invalid)).toEqual([]);
  });

  it("only the host changes settings or starts; ready needs a character; the room caps at 6", async () => {
    h = await startHarness();
    const a = await h.connect();
    const b = await h.connect();
    const code = await a.createAndJoin("Alice");
    await b.join(code, "Bob");
    const notHost = await b.request("update_settings", { campaign_pitch: "hijack" });
    expect(notHost.type === "error" && notHost.payload.code).toBe("not_host");
    const ok = await a.request("update_settings", { campaign_pitch: "A lighthouse mystery", content_rating: "family" });
    expect(ok.type).toBe("presence");
    const lobby = await b.wait("lobby_state", (p) => p.settings.campaign_pitch === "A lighthouse mystery");
    expect(lobby.payload.settings.content_rating).toBe("family");
    const noChar = await b.request("set_ready", { ready: true });
    expect(noChar.type).toBe("error");
    const start = await b.request("start_game", {});
    expect(start.type === "error" && start.payload.code).toBe("not_host");

    const extra = [];
    for (let i = 0; i < 5; i++) { const c = await h.connect(); extra.push(await c.join(code, `P${i}`)); }
    expect(extra.slice(0, 4).every((m) => m.type === "joined")).toBe(true);
    expect(extra[4]?.type).toBe("error");
  });

  it("claim_character gives the forge the room's pitch and the other characters' abilities", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const a = await h.connect();
    const b = await h.connect();
    const code = await a.createAndJoin("Alice");
    await b.join(code, "Bob");
    await a.request("update_settings", { campaign_pitch: "A drowned city of lanterns" });
    await a.request("claim_character", { character_id: "new", character: brindle() });
    await b.request("claim_character", { character_id: "new", character: tamsin() });
    const forges = provider.requests.filter((r) => r.purpose === "forge").map((r) => r.messages[0]!.content);
    expect(forges.length).toBeGreaterThan(3);
    expect(forges.every((u) => u.includes("Story: A drowned city of lanterns"))).toBe(true);
    expect(forges[0]).not.toContain("<party_abilities>");
    expect(forges.at(-1)).toContain("<party_abilities>");
    expect(forges.at(-1)).toContain("Brindle Ash:");
  });

  it("claim_character forges abilities within the level 1 budget and tells the player what the forge did", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.createAndJoin("Alice");
    const mark = a.mark();
    const r = await a.request("claim_character", { character_id: "new", character: brindle() });
    expect(r.type).toBe("character_claimed");
    const lobby = await a.wait("lobby_state", (p) => p.players[0]?.character_id !== null && !p.players[0]?.ready, { from: mark });
    const characterId = lobby.payload.players[0]?.character_id as string;
    expect(characterId).toBeTruthy();
    const lines = a.all("log", mark).filter((l) => l.payload.kind === "system").map((l) => l.payload.text);
    expect(lines.filter((l) => l.startsWith("Forged"))).toHaveLength(3);

    // the character the room holds: abilities priced by the engine, total within budget
    const room = h.server.rooms.all()[0]!;
    const ch = room.scratch.characters[characterId]!;
    expect(ch.abilities.length).toBeGreaterThanOrEqual(1);
    const total = ch.abilities.reduce((n, ab) => n + abilityCost(ab), 0);
    expect(total).toBeLessThanOrEqual(levelCaps(1).budget);
    expect(ch.abilities.every((ab) => ab.cost === abilityCost(ab))).toBe(true);
    expect(ch.user_id).toBe(a.playerId);

    const ready = await a.request("set_ready", { ready: true });
    expect(ready.type).toBe("presence");
    expect(a.invalid).toEqual([]);
  });

  it("rejects a bad point buy and duplicate names", async () => {
    h = await startHarness();
    const { a, b } = await lobbyOfTwo(h);
    const bad = await a.request("claim_character", { character_id: "new", character: { ...brindle("Other"), scores: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } } });
    expect(bad.type).toBe("error");
    const dup = await b.request("claim_character", { character_id: "new", character: tamsin("Brindle Ash") });
    expect(dup.type).toBe("error");
  });
});

describe("starting the game", () => {
  it("start_game sends a valid snapshot with both PCs placed, then streams the opening narration to done", async () => {
    h = await startHarness();
    const { a, b } = await lobbyOfTwo(h);
    const mark = a.mark();
    const r = await a.request("start_game", {});
    expect(r.type).toBe("presence");
    const snap = await a.wait("state_snapshot", () => true, { from: mark });
    const p = snap.payload;
    expect(p.mode).toBe("exploration");
    expect(p.party).toHaveLength(2);
    const pcs = p.entities.filter((e) => e.kind === "pc");
    expect(pcs).toHaveLength(2);
    expect(new Set(pcs.map((e) => e.owner_player_id))).toEqual(new Set([a.playerId, b.playerId]));
    for (const pc of pcs) expect(isWalkable(p.map, pc.x, pc.y)).toBe(true);
    expect(validateMap(p.map).errors).toEqual([]);
    expect(new Set(pcs.map((e) => `${e.x},${e.y}`)).size).toBe(2);

    const chunks = await a.wait("narration_chunk", (c) => c.done, { from: mark });
    const turn = chunks.payload.turn_id;
    const text = a.all("narration_chunk", mark).filter((c) => c.payload.turn_id === turn).map((c) => c.payload.text).join("");
    expect(text.split(/\s+/).length).toBeGreaterThanOrEqual(40);
    const lobby = await b.wait("lobby_state", (l) => l.phase === "playing");
    expect(lobby.payload.phase).toBe("playing");
    expect([a, b].flatMap((x) => x.invalid)).toEqual([]);
  });

  it("dev_solo allows the host to start alone; two ready players are otherwise required", async () => {
    h = await startHarness();
    const a = await h.connect();
    await a.createAndJoin("Solo");
    await a.request("claim_character", { character_id: "new", character: brindle() });
    const no = await a.request("start_game", {});
    expect(no.type).toBe("error");
    await a.request("update_settings", { dev_solo: true });
    const mark = a.mark();
    const yes = await a.request("start_game", {});
    expect(yes.type).toBe("presence");
    const snap = await a.wait("state_snapshot", () => true, { from: mark });
    expect(snap.payload.entities.filter((e) => e.kind === "pc")).toHaveLength(1);
  });
});

describe("story structure", () => {
  it("passes the room's plot settings to bible generation and gives the DM a pacing block", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const a = await h.connect();
    await a.createAndJoin("Solo");
    await a.request("claim_character", { character_id: "new", character: brindle() });
    await a.request("update_settings", { dev_solo: true, plot_pattern: "tragedy", plot_arc: "rise_fall" });
    await a.request("start_game", {});
    await a.wait("state_snapshot", () => true);
    const bibleReq = provider.requests.find((r) => r.purpose === "bible")!;
    expect(bibleReq.messages[0]!.content).toContain("pattern: tragedy");
    expect(bibleReq.messages[0]!.content).toContain("arc: rise_fall");
    const user = provider.dmRequests()[0]!.messages[0]!.content;
    expect(user).toContain("<pacing>");
    expect(user).toContain("Plot: Tragedy, arc: Soaring, then falling.");
    expect(user).toContain("Stage 1/5: Anticipation");
  });
  it("auto picks a valid plot", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider });
    const a = await h.connect();
    await a.createAndJoin("Solo");
    await a.request("claim_character", { character_id: "new", character: brindle() });
    await a.request("update_settings", { dev_solo: true, campaign_pitch: "A monster in the lair beneath the hill" });
    await a.request("start_game", {});
    await a.wait("state_snapshot", () => true);
    expect(provider.requests.find((r) => r.purpose === "bible")!.messages[0]!.content).toContain("pattern: overcoming_the_monster");
    expect(provider.dmRequests()[0]!.messages[0]!.content).toContain("<pacing>");
  });
});

describe("beats and the DM", () => {
  it("two IC says make one DM call; OOC chat never reaches a provider request", async () => {
    const provider = scriptedProvider();
    h = await startHarness({ provider, config: { beatWindowMs: 5000 } });
    const t = await startedTable(h);
    const before = provider.dmRequests().length;
    expect(before).toBe(1); // the opening
    const ma = t.a.mark();
    t.a.send("say", { text: "SECRET-OOC-MARKER lunch anyone", channel: "ooc" });
    t.a.send("say", { text: "I hum a quiet tune.", channel: "ic" });
    // OOC reached the other player as chat
    await t.b.wait("chat", (c) => c.channel === "ooc" && c.text.includes("SECRET-OOC-MARKER"));
    t.b.send("say", { text: "I tap my boots on the cobbles.", channel: "ic" });
    await t.a.wait("narration_chunk", (c) => c.done, { from: ma });
    expect(provider.dmRequests().length).toBe(before + 1);
    const user = provider.dmRequests().at(-1)!.messages[0]!.content;
    expect(user).toContain("I hum a quiet tune.");
    expect(user).toContain("I tap my boots on the cobbles.");
    for (const r of provider.requests) {
      expect(JSON.stringify(r)).not.toContain("SECRET-OOC-MARKER");
    }
  });
});
