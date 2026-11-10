import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonWorkshopStore, type WorkshopInput } from "../src/accounts/workshop";
import { pixelSprite, specSprite, startHarness, type Harness, type TestClient } from "./helpers";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.stop(); h = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const pixel = pixelSprite;
const spec = specSprite;
const input = (over: Partial<WorkshopInput> = {}): WorkshopInput => ({ name: "Heron", role_hint: "npc", concept: "a ferryman", tags: [], recipe: spec(), source: "designed", ...over });

async function register(c: TestClient, username: string) {
  const r = await c.request("register", { username, password: "a-very-secret-passphrase", display_name: username });
  if (r.type !== "auth_ok") throw new Error("register failed");
  return r.payload;
}
async function list(c: TestClient) {
  const r = await c.request("list_sprite_assets", {});
  if (r.type !== "sprite_assets_list") throw new Error(`list failed: ${JSON.stringify(r)}`);
  return r.payload;
}

describe("Workshop store", () => {
  const tmp = async () => { const d = await mkdtemp(join(tmpdir(), "aedm-ws-")); dirs.push(d); return d; };

  it("creates, updates, lists newest first, persists across instances and deletes", async () => {
    const dir = await tmp();
    let t = 1_700_000_000_000;
    const clock = () => (t += 1000);
    const s = new JsonWorkshopStore({ dir, clock });
    const a = await s.save("u_1", input({ name: "One" }));
    const b = await s.save("u_1", input({ name: "Two" }));
    if (!a.ok || !b.ok) throw new Error("save failed");
    expect(a.value.id).toMatch(/^as_/);
    const upd = await s.save("u_1", input({ name: "One v2", role_hint: "enemy" }), a.value.id);
    expect(upd.ok && upd.value.created_at).toBe(a.value.created_at);
    const l = await s.list("u_1");
    expect(l.assets.map((x) => x.name)).toEqual(["One v2", "Two"]);
    expect(l.assets[0]).not.toHaveProperty("owner_user_id");

    const again = new JsonWorkshopStore({ dir, clock });
    expect((await again.list("u_1")).assets).toHaveLength(2);
    expect((await again.list("u_2")).assets).toHaveLength(0);
    expect(await again.get("u_2", a.value.id)).toBeNull();
    expect(await again.delete("u_2", a.value.id)).toBe(false);
    expect(await again.delete("u_1", a.value.id)).toBe(true);
    expect((await again.list("u_1")).assets.map((x) => x.name)).toEqual(["Two"]);
    expect(await readdir(dir)).toEqual(["u_1.json"]);
  });

  it("refuses an update of someone else's or a missing asset", async () => {
    const s = new JsonWorkshopStore({ dir: await tmp() });
    const a = await s.save("u_1", input());
    if (!a.ok) throw new Error();
    const r = await s.save("u_2", input(), a.value.id);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("not_found");
  });

  it("enforces the asset count (updates still allowed at the limit)", async () => {
    const s = new JsonWorkshopStore({ dir: await tmp(), limits: { maxAssets: 2 } });
    const a = await s.save("u_1", input({ name: "A" }));
    await s.save("u_1", input({ name: "B" }));
    const c = await s.save("u_1", input({ name: "C" }));
    expect(!c.ok && c.code).toBe("limit");
    if (!a.ok) throw new Error();
    expect((await s.save("u_1", input({ name: "A2" }), a.value.id)).ok).toBe(true);
    await s.delete("u_1", a.value.id);
    expect((await s.save("u_1", input({ name: "C" }))).ok).toBe(true);
  });

  it("enforces the byte limit and counts it", async () => {
    const s = new JsonWorkshopStore({ dir: await tmp(), limits: { maxBytes: 3000 } });
    const first = await s.save("u_1", input({ recipe: pixel(), source: "painted" }));
    expect(first.ok).toBe(true);
    const used = (await s.usageOf("u_1")).used_bytes;
    expect(used).toBeGreaterThan(500);
    const results = await Promise.all([1, 2, 3, 4].map((i) => s.save("u_1", input({ name: `P${i}`, recipe: pixel(), source: "painted" }))));
    expect(results.some((r) => !r.ok && r.code === "limit")).toBe(true);
    expect((await s.usageOf("u_1")).used_bytes).toBeLessThanOrEqual(3000);
  });

  it("validates pixel recipes with the engine", async () => {
    const s = new JsonWorkshopStore({ dir: await tmp() });
    const bad = await s.save("u_1", input({ recipe: pixel([0, 10, 31, 60]), source: "painted" }));
    expect(!bad.ok && bad.code).toBe("invalid_sprite");
    expect((await s.list("u_1")).assets).toHaveLength(0);
    const mismatch = await s.save("u_1", input({ source: "painted" }));
    expect(!mismatch.ok && mismatch.code).toBe("invalid");
  });

  it("ignores a hand-edited file entry that no longer validates", async () => {
    const dir = await tmp();
    const s = new JsonWorkshopStore({ dir });
    await s.save("u_1", input());
    const { readFile, writeFile } = await import("node:fs/promises");
    const f = join(dir, "u_1.json");
    const data = JSON.parse(await readFile(f, "utf8"));
    data.assets.push({ id: "as_bad", nonsense: true });
    await writeFile(f, JSON.stringify(data));
    expect((await new JsonWorkshopStore({ dir }).list("u_1")).assets).toHaveLength(1);
  });
});

describe("Workshop over the socket", () => {
  const save = (over: Record<string, unknown> = {}) => ({ name: "Heron", role_hint: "npc", concept: "a ferryman", tags: ["heron"], recipe: spec(), source: "designed", ...over });

  it("guests get a clear error", async () => {
    h = await startHarness();
    const g = await h.connect();
    for (const [type, payload] of [["list_sprite_assets", {}], ["save_sprite_asset", save()], ["delete_sprite_asset", { id: "as_x" }]] as const) {
      const r = await g.request(type, payload);
      expect(r.type).toBe("error");
      if (r.type === "error") { expect(r.payload.code).toBe("forbidden"); expect(r.payload.message).toContain("Log in"); }
    }
    expect(g.invalid).toEqual([]);
  });

  it("an account saves, lists, updates and deletes; another account never sees it", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "alice");
    expect((await list(a)).assets).toEqual([]);
    const r = await a.request("save_sprite_asset", save());
    if (r.type !== "sprite_assets_list") throw new Error(JSON.stringify(r));
    expect(r.payload.assets).toHaveLength(1);
    expect(r.payload.max_assets).toBe(200);
    expect(r.payload.max_bytes).toBe(5 * 1024 * 1024);
    expect(r.payload.used_bytes).toBeGreaterThan(0);
    const id = r.payload.assets[0]!.id;

    const up = await a.request("save_sprite_asset", save({ id, name: "Heron II", recipe: pixel(), source: "painted_over" }));
    expect(up.type === "sprite_assets_list" && up.payload.assets[0]?.name).toBe("Heron II");
    expect(up.type === "sprite_assets_list" && up.payload.assets[0]?.recipe.kind).toBe("pixel");

    const b = await h.connect();
    await register(b, "bob");
    expect((await list(b)).assets).toEqual([]);
    const stolen = await b.request("delete_sprite_asset", { id });
    expect(stolen.type === "error" && stolen.payload.code).toBe("not_found");
    const overwrite = await b.request("save_sprite_asset", save({ id }));
    expect(overwrite.type === "error" && overwrite.payload.code).toBe("not_found");

    const del = await a.request("delete_sprite_asset", { id });
    expect(del.type === "sprite_assets_list" && del.payload.assets).toEqual([]);
    expect([a, b].flatMap((c) => c.invalid)).toEqual([]);
  });

  it("a rejected painting answers invalid_sprite", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "alice");
    const r = await a.request("save_sprite_asset", save({ recipe: pixel([0, 10, 31, 60]), source: "painted" }));
    expect(r.type === "error" && r.payload.code).toBe("invalid_sprite");
    expect((await list(a)).assets).toEqual([]);
  });

  it("survives a re-login (the library belongs to the account)", async () => {
    h = await startHarness();
    const a = await h.connect();
    await register(a, "alice");
    await a.request("save_sprite_asset", save());
    const b = await h.connect();
    const lr = await b.request("login", { username: "alice", password: "a-very-secret-passphrase" });
    expect(lr.type).toBe("auth_ok");
    expect((await list(b)).assets).toHaveLength(1);
  });
});
