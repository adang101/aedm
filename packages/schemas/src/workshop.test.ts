import { describe, expect, it } from "vitest";
import { CastEntrySchema, WORKSHOP_MAX_ASSETS, WorkshopAssetRecordSchema, WorkshopAssetSchema } from "./workshop";
import { ClientMessageSchema, RoomSettingsSchema, ServerMessageSchema, WS_VERSION } from "./ws";
import { CreateEnemyActionSchema, CreateNpcActionSchema } from "./dm";
import { EnemySchema } from "./enemy";
import { PIXEL_COUNT, encodePixels } from "./pixel";

const env = (type: string, payload: unknown, extra: object = {}) => ({ v: WS_VERSION, type, id: "c1", ts: 1700000000000, payload, ...extra });
const shape = { kind: "shape", shape: "circle", color: "#112233", accent: "#445566", glyph: "A" };
const spec = {
  kind: "spec", v: 1, body: "avian", size: "medium", glyph: "H", traits: "lantern",
  palette: { primary: "#112233", secondary: "#445566", accent: "#778899", detail: "#001122" }, parts: [{ part: "lantern" }],
};
const pixel = { kind: "pixel", v: 1, width: 48, height: 64, palette: ["#1b1626"], pixels: encodePixels(new Uint8Array(PIXEL_COUNT)), size: "medium", traits: "" };
const now = "2026-01-01T00:00:00.000Z";
const asset = { id: "as_abc123", name: "Heron", role_hint: "npc", concept: "a ferryman", tags: ["heron"], recipe: spec, source: "designed", created_at: now, updated_at: now };

describe("Workshop asset", () => {
  it("accepts spec, shape and pixel recipes with a matching source", () => {
    expect(WorkshopAssetSchema.safeParse(asset).success).toBe(true);
    expect(WorkshopAssetSchema.safeParse({ ...asset, recipe: shape }).success).toBe(true);
    expect(WorkshopAssetSchema.safeParse({ ...asset, recipe: pixel, source: "painted" }).success).toBe(true);
    expect(WorkshopAssetSchema.safeParse({ ...asset, recipe: pixel, source: "painted_over" }).success).toBe(true);
  });
  it("rejects a source that contradicts the recipe, bad ids, long names and unknown fields", () => {
    expect(WorkshopAssetSchema.safeParse({ ...asset, source: "painted" }).success).toBe(false);
    expect(WorkshopAssetSchema.safeParse({ ...asset, recipe: pixel }).success).toBe(false);
    expect(WorkshopAssetSchema.safeParse({ ...asset, id: "x_1" }).success).toBe(false);
    expect(WorkshopAssetSchema.safeParse({ ...asset, name: "x".repeat(41) }).success).toBe(false);
    expect(WorkshopAssetSchema.safeParse({ ...asset, role_hint: "dragon" }).success).toBe(false);
    expect(WorkshopAssetSchema.safeParse({ ...asset, owner_user_id: "u1" }).success).toBe(false);
  });
  it("the stored record carries the owner", () => {
    expect(WorkshopAssetRecordSchema.safeParse({ ...asset, owner_user_id: "u1" }).success).toBe(true);
    expect(WorkshopAssetRecordSchema.safeParse(asset).success).toBe(false);
  });
});

describe("Workshop messages", () => {
  const save = { name: "Heron", role_hint: "npc", concept: "", recipe: spec, source: "designed" };
  it("save_sprite_asset: create or update", () => {
    expect(ClientMessageSchema.safeParse(env("save_sprite_asset", save)).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("save_sprite_asset", { ...save, id: "as_abc" })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("save_sprite_asset", { ...save, source: "painted" })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("save_sprite_asset", { ...save, owner_user_id: "u" })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("save_sprite_asset", { ...save, tags: ["a", "b", "c", "d", "e", "f"] })).success).toBe(false);
  });
  it("delete, list, offer and decide", () => {
    expect(ClientMessageSchema.safeParse(env("delete_sprite_asset", { id: "as_abc" })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("delete_sprite_asset", { id: "nope" })).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("list_sprite_assets", {})).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("offer_to_cast", { asset_id: "as_abc" })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("offer_to_cast", {})).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("cast_decision", { asset_id: "as_abc", approve: true })).success).toBe(true);
    expect(ClientMessageSchema.safeParse(env("cast_decision", { asset_id: "as_abc" })).success).toBe(false);
  });
  it("sprite_assets_list and cast_state", () => {
    const list = { assets: [asset], used_bytes: 100, max_assets: WORKSHOP_MAX_ASSETS, max_bytes: 5 * 1024 * 1024 };
    expect(ServerMessageSchema.safeParse(env("sprite_assets_list", list, { ack_id: "c1" })).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("sprite_assets_list", { ...list, assets: [{ ...asset, owner_user_id: "u" }] })).success).toBe(false);
    const entry = { asset_id: "as_abc", owner_player_id: "p1", owner_name: "Ana", name: "Heron", role_hint: "npc", concept: "", recipe: spec, status: "pending" };
    expect(CastEntrySchema.safeParse(entry).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("cast_state", { entries: [entry, { ...entry, status: "approved" }] })).success).toBe(true);
    expect(ServerMessageSchema.safeParse(env("cast_state", { entries: [{ ...entry, status: "maybe" }] })).success).toBe(false);
  });
});

describe("room settings and asset_ref", () => {
  const base = { content_rating: "teen", campaign_pitch: "", dev_solo: false };
  it("custom_cast and custom_paintings are optional and validated", () => {
    expect(RoomSettingsSchema.safeParse(base).success).toBe(true);
    for (const m of ["off", "host_approval", "open"]) expect(RoomSettingsSchema.safeParse({ ...base, custom_cast: m, custom_paintings: false }).success).toBe(true);
    expect(RoomSettingsSchema.safeParse({ ...base, custom_cast: "anyone" }).success).toBe(false);
    expect(RoomSettingsSchema.safeParse({ ...base, custom_paintings: "yes" }).success).toBe(false);
    expect(ClientMessageSchema.safeParse(env("update_settings", { custom_cast: "open" })).success).toBe(true);
  });
  it("create_npc and create_enemy take an optional asset_ref", () => {
    const npc = { type: "create_npc", name: "Wren", concept: "c", role: "bystander", map_id: "m_a", x: 1, y: 1, sprite_tags: [] };
    expect(CreateNpcActionSchema.safeParse(npc).success).toBe(true);
    expect(CreateNpcActionSchema.safeParse({ ...npc, asset_ref: "as_abc" }).success).toBe(true);
    expect(CreateNpcActionSchema.safeParse({ ...npc, asset_ref: "bad" }).success).toBe(false);
    const foe = { type: "create_enemy", concept: "c", role: "standard" };
    expect(CreateEnemyActionSchema.safeParse({ ...foe, asset_ref: "as_abc" }).success).toBe(true);
    expect(CreateEnemyActionSchema.safeParse({ ...foe, asset_ref: "en_x" }).success).toBe(false);
  });
  it("an enemy archetype may carry any sprite recipe", () => {
    const shape2 = EnemySchema.shape.sprite;
    expect(shape2.safeParse(pixel).success).toBe(true);
    expect(shape2.safeParse(spec).success).toBe(true);
  });
});
