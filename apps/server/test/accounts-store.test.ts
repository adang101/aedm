import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/accounts/password";
import { JsonAccountStore, MAX_SESSIONS_PER_USER, SESSION_TTL_MS, summarize } from "../src/accounts/store";
import { brindle } from "./helpers";

let dir = "";
let now = 1_700_000_000_000;
const clock = () => now;
const store = () => new JsonAccountStore({ dir, clock });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aedm-accounts-"));
  now = 1_700_000_000_000;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const reg = (s: JsonAccountStore, username = "alice", password = "correct horse") =>
  s.register({ username, password, display_name: "Alice" });

describe("password hashing", () => {
  it("uses scrypt$N$r$p$salt$hash with N=16384, r=8, p=1, a 16-byte salt and a 64-byte key", async () => {
    const h = await hashPassword("hunter2hunter2");
    const [alg, n, r, p, salt, key] = h.split("$");
    expect([alg, n, r, p]).toEqual(["scrypt", "16384", "8", "1"]);
    expect(Buffer.from(salt as string, "base64")).toHaveLength(16);
    expect(Buffer.from(key as string, "base64")).toHaveLength(64);
    expect(await verifyPassword("hunter2hunter2", h)).toBe(true);
    expect(await verifyPassword("hunter2hunter3", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await hashPassword("hunter2hunter2")).not.toBe(h); // fresh salt every time
  });
});

describe("JsonAccountStore", () => {
  it("registers, normalizes the username and rejects duplicates case-insensitively", async () => {
    const s = store();
    const a = await reg(s, "Alice_1");
    expect(a.ok && a.value.username).toBe("alice_1");
    expect(a.ok && a.value.id).toMatch(/^u_/);
    expect(a.ok && a.value.password_hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    const dup = await reg(s, "ALICE_1");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("username_taken");
    for (const [u, p, d] of [["ab", "longenough", "X"], ["bad name", "longenough", "X"], ["okname", "short", "X"], ["okname", "longenough", " "], ["okname", "x".repeat(129), "X"]] as const) {
      const r = await s.register({ username: u, password: p, display_name: d });
      expect(r.ok === false && r.code).toBe("invalid");
    }
  });

  it("verifies logins: right password yes, wrong password and unknown user both null", async () => {
    const s = store();
    await reg(s);
    expect((await s.verifyLogin("ALICE", "correct horse"))?.username).toBe("alice");
    expect(await s.verifyLogin("alice", "wrong horse")).toBeNull();
    expect(await s.verifyLogin("nobody", "correct horse")).toBeNull();
  });

  it("creates, resumes, slides, expires and deletes sessions; stores only a hash of the token", async () => {
    const s = store();
    const u = await reg(s);
    if (!u.ok) throw new Error("register");
    const { token, expires_at } = await s.createSession(u.value.id);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(expires_at).toBe(now + SESSION_TTL_MS);
    const file = await readFile(join(dir, "sessions.json"), "utf8");
    expect(file).not.toContain(token);

    expect((await s.resumeSession(token))?.id).toBe(u.value.id);
    expect(await s.resumeSession("nope")).toBeNull();

    now += 5 * 24 * 60 * 60 * 1000;
    expect((await s.resumeSession(token))?.id).toBe(u.value.id); // slid forward 5 days
    now += SESSION_TTL_MS - 24 * 60 * 60 * 1000; // 1 day short of the refreshed expiry
    expect(await s.resumeSession(token)).not.toBeNull();
    now += 2 * SESSION_TTL_MS;
    expect(await s.resumeSession(token)).toBeNull(); // expired

    const t2 = await s.createSession(u.value.id);
    await s.deleteSession(t2.token);
    expect(await s.resumeSession(t2.token)).toBeNull();
  });

  it("keeps at most 10 sessions per user, dropping the oldest", async () => {
    const s = store();
    const u = await reg(s);
    if (!u.ok) throw new Error("register");
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i++) {
      now += 1000;
      tokens.push((await s.createSession(u.value.id)).token);
    }
    expect(await s.resumeSession(tokens[0] as string)).toBeNull();
    expect(await s.resumeSession(tokens[1] as string)).toBeNull();
    expect(await s.resumeSession(tokens[2] as string)).not.toBeNull();
    expect(await s.resumeSession(tokens.at(-1) as string)).not.toBeNull();
  });

  it("survives a restart: users, sessions and characters reload from disk", async () => {
    const s = store();
    const u = await reg(s);
    if (!u.ok) throw new Error("register");
    const { token } = await s.createSession(u.value.id);
    const saved = await s.saveCharacter(u.value.id, brindle());
    expect(saved.ok).toBe(true);
    const s2 = store();
    const back = await s2.resumeSession(token);
    expect(back?.characters.map((c) => c.character.name)).toEqual(["Brindle Ash"]);
    expect((await s2.verifyLogin("alice", "correct horse"))?.id).toBe(u.value.id);
  });

  it("20 concurrent registrations all land in a valid users.json with no temp file left behind", async () => {
    const s = store();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.register({ username: `user_${i}`, password: "password-" + i, display_name: `U${i}` })));
    expect(results.every((r) => r.ok)).toBe(true);
    const file = JSON.parse(await readFile(join(dir, "users.json"), "utf8")) as { users: { username: string }[] };
    expect(new Set(file.users.map((u) => u.username)).size).toBe(20);
    expect(await readdir(dir)).toEqual(["users.json"]);
    // racing for the same name: exactly one wins
    const same = await Promise.all(Array.from({ length: 5 }, () => s.register({ username: "highlander", password: "password-x", display_name: "H" })));
    expect(same.filter((r) => r.ok)).toHaveLength(1);
  });

  it("saves, replaces by name, summarizes and deletes character templates", async () => {
    const s = store();
    const u = await reg(s);
    if (!u.ok) throw new Error("register");
    const a = await s.saveCharacter(u.value.id, brindle());
    if (!a.ok) throw new Error("save");
    const again = await s.saveCharacter(u.value.id, brindle("brindle ash"));
    expect(again.ok && again.value.id).toBe(a.value.id); // same name (any case) updates in place
    expect((await s.getUser(u.value.id))?.characters).toHaveLength(1);
    const sum = summarize(a.value);
    expect(sum.ability_names).toEqual(["Shaped Charge", "Tripwire Cache", "Smoke Pop"]);
    expect(await s.deleteCharacter(u.value.id, "nope")).toBe(false);
    expect(await s.deleteCharacter(u.value.id, a.value.id)).toBe(true);
    expect((await s.getUser(u.value.id))?.characters).toHaveLength(0);
  });
});
