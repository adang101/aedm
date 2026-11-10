import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brindle, startHarness, tamsin, type Harness, type TestClient } from "./helpers";

let h: Harness | undefined;
afterEach(async () => { await h?.stop(); h = undefined; });

const PASSWORD = "a-very-secret-passphrase";

async function register(c: TestClient, username: string, display = "Display " + username, password = PASSWORD) {
  const r = await c.request("register", { username, password, display_name: display });
  if (r.type !== "auth_ok") throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.payload;
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

describe("accounts: auth", () => {
  it("register returns auth_ok with a session token; the username is lowercased; duplicates and bad input get auth_error", async () => {
    h = await startHarness();
    const a = await h.connect();
    const ok = await register(a, "Alice_01", "Alice");
    expect(ok.user.username).toBe("alice_01");
    expect(ok.user.display_name).toBe("Alice");
    expect(ok.user.id).toMatch(/^u_/);
    expect(ok.session_token?.length).toBeGreaterThanOrEqual(43);
    expect(ok.characters).toEqual([]);

    const b = await h.connect();
    const dup = await b.request("register", { username: "ALICE_01", password: PASSWORD, display_name: "Imposter" });
    expect(dup.type === "auth_error" && dup.payload.code).toBe("username_taken");
    for (const bad of [
      { username: "ab", password: PASSWORD, display_name: "X" },
      { username: "has space", password: PASSWORD, display_name: "X" },
      { username: "fine_name", password: "short", display_name: "X" },
      { username: "fine_name", password: PASSWORD, display_name: "" },
    ]) {
      const r = await b.request("register", bad);
      expect(r.type === "auth_error" && r.payload.code).toBe("invalid");
    }
    expect([a, b].flatMap((x) => x.invalid)).toEqual([]);
  });

  it("login: wrong password and unknown user get the same auth_error; the right one gets a token", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "carol");
    const b = await h.connect();
    const wrong = await b.request("login", { username: "carol", password: "not-the-password" });
    const unknown = await b.request("login", { username: "nobody", password: "not-the-password" });
    expect(wrong.type).toBe("auth_error");
    expect(unknown.type).toBe("auth_error");
    if (wrong.type === "auth_error" && unknown.type === "auth_error") {
      expect(wrong.payload).toEqual(unknown.payload);
      expect(wrong.payload.code).toBe("invalid_credentials");
    }
    const ok = await b.request("login", { username: "CAROL", password: PASSWORD });
    expect(ok.type).toBe("auth_ok");
    expect(ok.type === "auth_ok" && ok.payload.session_token).toBeTruthy();
  });

  it("resume_session restores a login on a new connection (without a new token); logout ends the session", async () => {
    h = await startHarness();
    const a = await h.connect();
    const { session_token: token } = await register(a, "dana");
    const b = await h.connect();
    const r = await b.request("resume_session", { session_token: token });
    expect(r.type).toBe("auth_ok");
    expect(r.type === "auth_ok" && r.payload.session_token).toBeUndefined();
    expect(r.type === "auth_ok" && r.payload.user.username).toBe("dana");

    const bad = await (await h.connect()).request("resume_session", { session_token: "not-a-real-token" });
    expect(bad.type === "auth_error" && bad.payload.code).toBe("invalid_credentials");

    const out = await b.request("logout", {});
    expect(out.type).toBe("logged_out");
    const after = await b.request("list_characters", {});
    expect(after.type === "error" && after.payload.code).toBe("forbidden");
    const again = await (await h.connect()).request("resume_session", { session_token: token });
    expect(again.type).toBe("auth_error");
  });

  it("rate limits attempts per connection and failed logins per username", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "erin");
    const c = await h.connect();
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await c.request("login", { username: `ghost${i}`, password: "whatever-password" });
      codes.push(r.type === "auth_error" ? r.payload.code : r.type);
    }
    expect(codes.slice(0, 5).every((x) => x === "invalid_credentials")).toBe(true);
    expect(codes.slice(5)).toEqual(["rate_limited", "rate_limited"]);

    // many connections guessing one account: the username locks after 5 failures, even for the right password
    const conns = [await h.connect(), await h.connect(), await h.connect()];
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await (conns[i % 3] as TestClient).request("login", { username: "erin", password: "wrong-password-" + i });
      seen.push(r.type === "auth_error" ? r.payload.code : r.type);
    }
    expect(seen.every((x) => x === "invalid_credentials")).toBe(true);
    const locked = await (conns[0] as TestClient).request("login", { username: "erin", password: PASSWORD });
    expect(locked.type === "auth_error" && locked.payload.code).toBe("rate_limited");
  });

  it("the password and token appear nowhere under the data dir except as a scrypt hash and a token hash", async () => {
    h = await startHarness();
    const a = await h.connect();
    const { session_token: token } = await register(a, "frank");
    await a.request("save_character_template", { character: brindle() });
    const files = await allFiles(h.dataDir);
    expect(files.some((f) => f.endsWith("users.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("sessions.json"))).toBe(true);
    for (const f of files) {
      const text = await readFile(f, "utf8");
      expect(text, f).not.toContain(PASSWORD);
      expect(text, f).not.toContain(token as string);
    }
    const users = JSON.parse(await readFile(join(h.dataDir, "accounts", "users.json"), "utf8")) as { users: { password_hash: string }[] };
    expect(users.users[0]?.password_hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });
});

describe("accounts: characters", () => {
  it("saves, lists, claims by template (forge runs, abilities are remembered), and deletes; guests cannot", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "gwen");
    const saved = await a.request("save_character_template", { character: brindle() });
    expect(saved.type).toBe("characters_list");
    const list = saved.type === "characters_list" ? saved.payload.characters : [];
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Brindle Ash");
    expect(list[0]?.forged).toBe(false);
    expect(JSON.stringify(list)).not.toContain("ability_texts"); // summaries only
    const tplId = list[0]?.id as string;

    await a.createAndJoin("Gwen");
    const claim = await a.request("claim_character", { character_id: "template", template_id: tplId });
    expect(claim.type).toBe("character_claimed");
    const room = h.server.rooms.all()[0]!;
    const ch = room.scratch.characters[(claim as { payload: { character_id: string } }).payload.character_id]!;
    expect(ch.name).toBe("Brindle Ash");
    expect(ch.abilities.length).toBeGreaterThanOrEqual(1);
    expect(ch.user_id).toBe(a.playerId);

    const after = await a.request("list_characters", {});
    expect(after.type === "characters_list" && after.payload.characters[0]?.forged).toBe(true);

    // "Save to my characters" after a normal claim keeps the forged abilities
    const second = await a.request("claim_character", { character_id: "new", character: tamsin() });
    expect(second.type).toBe("character_claimed");
    const saved2 = await a.request("save_character_template", { character: tamsin() });
    expect(saved2.type === "characters_list" && saved2.payload.characters.find((c) => c.name === "Tamsin Quickfoot")?.forged).toBe(true);

    // a guest in the same room cannot use it
    const g = await h.connect();
    await g.join(a.code, "Guest");
    const denied = await g.request("claim_character", { character_id: "template", template_id: tplId });
    expect(denied.type === "error" && denied.payload.code).toBe("not_found");
    const noList = await g.request("list_characters", {});
    expect(noList.type === "error" && noList.payload.code).toBe("forbidden");

    // another account cannot use or delete it
    const o = await h.connect();
    await register(o, "other_user");
    const stolen = await o.request("delete_character_template", { id: tplId });
    expect(stolen.type === "error" && stolen.payload.code).toBe("not_found");

    const del = await a.request("delete_character_template", { id: tplId });
    expect(del.type === "characters_list" && del.payload.characters.map((c) => c.name)).toEqual(["Tamsin Quickfoot"]);
    expect([a, g, o].flatMap((x) => x.invalid)).toEqual([]);
  });
});

describe("accounts: rooms and campaigns", () => {
  it("a logged-in player is rebound to their seat by account, without the room token", async () => {
    h = await startHarness();
    const a = await h.connect();
    const { session_token } = await register(a, "hana");
    const code = await a.createAndJoin("Hana");
    const seat = a.playerId;
    a.close();

    const b = await h.connect();
    await b.request("resume_session", { session_token });
    const r = await b.join(code, "Whoever"); // no auth_token
    expect(r.type).toBe("joined");
    expect(b.playerId).toBe(seat);
    expect(h.server.rooms.all()[0]?.players).toHaveLength(1);

    // a guest without the token gets a new seat, not hana's
    const g = await h.connect();
    await g.join(code, "Whoever");
    expect(g.playerId).not.toBe(seat);
  });

  it("saves are owned by the host's account: list_campaigns shows them and resume_campaign restores into a new room", async () => {
    h = await startHarness();
    const a = await h.connect();
    const guest = await h.connect();
    const b = await h.connect();
    const { session_token: tokenA } = await register(a, "ivy_host", "Ivy");
    const { session_token: tokenB } = await register(b, "jon_friend", "Jon");
    const code = await a.createAndJoin("Ivy");
    await guest.join(code, "Guest");
    await b.join(code, "Jon");
    const orrin = { ...brindle("Orrin Vale"), sprite_recipe: tamsin().sprite_recipe };
    expect((await a.request("claim_character", { character_id: "new", character: brindle() })).type).toBe("character_claimed");
    expect((await guest.request("claim_character", { character_id: "new", character: tamsin() })).type).toBe("character_claimed");
    expect((await b.request("claim_character", { character_id: "new", character: orrin })).type).toBe("character_claimed");
    for (const c of [a, guest, b]) await c.request("set_ready", { ready: true });
    const ma = a.mark();
    expect((await a.request("start_game", {})).type).toBe("presence");
    await a.wait("narration_chunk", (p) => p.done, { from: ma });

    const named = await a.request("request_save", { name: "Before the marsh" });
    expect(named.type).toBe("presence");
    const created = await a.wait("save_created", (s) => s.name === "Before the marsh");
    const saveId = created.payload.save_id;
    const roomId = (await a.wait("lobby_state")).payload.room_id;

    // metadata on disk
    const file = JSON.parse(await readFile(join(h.saveDir, roomId, `${saveId}.json`), "utf8"));
    expect(file.owner_user_id).toMatch(/^u_/);
    expect(file.campaign_title).toBeTruthy();
    expect(Object.values(file.room.player_user_ids)).toHaveLength(2);
    expect(Object.values(file.room.settings)).toBeTruthy();

    // listing: the host sees it; a guest cannot ask; the friend (not the owner) sees nothing
    const listed = await a.request("list_campaigns", {});
    const campaigns = listed.type === "campaigns_list" ? listed.payload.campaigns : [];
    expect(campaigns.find((c) => c.save_id === saveId)).toMatchObject({ room_id: roomId, name: "Before the marsh", kind: "named", can_resume: true });
    expect(campaigns.filter((c) => c.kind === "autosave")).toHaveLength(1);
    expect(campaigns[0]?.players).toEqual(["Ivy", "Guest", "Jon"]);
    const none = await b.request("list_campaigns", {});
    expect(none.type === "campaigns_list" && none.payload.campaigns).toEqual([]);
    const gl = await (await h.connect()).request("list_campaigns", {});
    expect(gl.type === "error" && gl.payload.code).toBe("forbidden");

    // a different account cannot resume it
    const bOut = await h.connect();
    await bOut.request("resume_session", { session_token: tokenB });
    const denied = await bOut.request("resume_campaign", { save_id: saveId, room_id: roomId });
    expect(denied.type === "error" && denied.payload.code).toBe("not_found");

    // the owner resumes on a fresh connection (as after a page reload)
    const a2 = await h.connect();
    expect((await a2.request("resume_session", { session_token: tokenA })).type).toBe("auth_ok");
    const created2 = await a2.request("resume_campaign", { save_id: saveId, room_id: roomId });
    expect(created2.type).toBe("room_created");
    if (created2.type !== "room_created") return;
    expect(created2.payload.room_id).not.toBe(roomId);
    const joined = await a2.join(created2.payload.invite_code, "Ivy");
    expect(joined.type).toBe("joined");
    const lobby = await a2.wait("lobby_state", (p) => p.resume_save !== undefined);
    expect(lobby.payload.resume_save).toEqual({ save_id: saveId, name: "Before the marsh" });
    expect(lobby.payload.host_player_id).toBe(a2.playerId);

    // Jon rejoins by account; the guest does not come back
    const b2 = await h.connect();
    await b2.request("resume_session", { session_token: tokenB });
    await b2.join(created2.payload.invite_code, "Jon");

    const m2 = a2.mark();
    const load = await a2.request("load_save", { save_id: saveId });
    expect(load.type).toBe("presence");
    const snap = await a2.wait("state_snapshot", () => true, { from: m2 });
    const pcs = snap.payload.entities.filter((e) => e.kind === "pc");
    expect(pcs).toHaveLength(3);
    const myPc = pcs.find((e) => e.owner_player_id === a2.playerId);
    const jonPc = pcs.find((e) => e.owner_player_id === b2.playerId);
    expect(myPc?.name).toBe("Brindle Ash");
    expect(jonPc?.name).toBe("Orrin Vale"); // by account, not by seat order
    const after = await a2.wait("lobby_state", (p) => p.phase === "playing");
    expect(after.payload.resume_save).toBeUndefined();

    // a guest-hosted room's saves belong to nobody: they never appear in anyone's list
    const g = await h.connect();
    await g.createAndJoin("Solo");
    await g.request("claim_character", { character_id: "new", character: brindle("Solo Hero") });
    await g.request("update_settings", { dev_solo: true });
    const mg = g.mark();
    await g.request("start_game", {});
    await g.wait("narration_chunk", (p) => p.done, { from: mg });
    await g.request("request_save", { name: "guest save" });
    await g.wait("save_created");
    const again = await a2.request("list_campaigns", {});
    expect(again.type === "campaigns_list" && again.payload.campaigns.some((c) => c.name === "guest save")).toBe(false);

    expect([a, guest, b, a2, b2, g].flatMap((x) => x.invalid)).toEqual([]);
  });

  it("load_save refuses an account-owned save to a host who is not the owner", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "owner_a");
    await a.createAndJoin("Owner");
    await a.request("claim_character", { character_id: "new", character: brindle() });
    await a.request("update_settings", { dev_solo: true });
    const ma = a.mark();
    await a.request("start_game", {});
    await a.wait("narration_chunk", (p) => p.done, { from: ma });
    await a.request("request_save", { name: "mine" });
    const { save_id } = (await a.wait("save_created")).payload;

    const g = await h.connect();
    await g.createAndJoin("Thief");
    const r = await g.request("load_save", { save_id });
    expect(r.type === "error" && r.payload.code).toBe("not_found");
  });
});
