import type { CharacterSummary, ServerMessage } from "@aedm/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionToken, loadSessionToken, saveSessionToken } from "./storage";
import { applyServerMessage, createInitialState, resetRoom } from "./store";

let n = 0;
const msg = <T extends ServerMessage["type"]>(type: T, payload: Extract<ServerMessage, { type: T }>["payload"]) =>
  ({ v: 1, type, id: `s${++n}`, ts: 0, payload }) as unknown as ServerMessage;

const sprite = { kind: "shape", shape: "circle", color: "#4f8a3c", accent: "#f6e8a0", glyph: "A" } as const;
const summary: CharacterSummary = { id: "ch_1", name: "Ana", title: "", key_ability: "str", sprite_recipe: sprite, ability_names: ["Slash"], forged: false, saved_at: "2026-01-01T00:00:00Z" };
const user = { id: "u_1", username: "ana", display_name: "Ana K" };

describe("auth state", () => {
  it("starts signed out", () => {
    const s = createInitialState();
    expect(s.auth).toEqual({ user: null, pending: false, error: null, characters: [], campaigns: null });
  });

  it("auth_ok signs in, keeps the characters and defaults the display name", () => {
    const s = createInitialState();
    s.auth.pending = true;
    s.auth.error = "old";
    applyServerMessage(s, msg("auth_ok", { user, characters: [summary] }), 0);
    expect(s.auth.user).toEqual(user);
    expect(s.auth.characters).toHaveLength(1);
    expect(s.auth.pending).toBe(false);
    expect(s.auth.error).toBeNull();
    expect(s.displayName).toBe("Ana K");
  });

  it("auth_error records the message and stops the spinner", () => {
    const s = createInitialState();
    s.auth.pending = true;
    applyServerMessage(s, msg("auth_error", { code: "invalid_credentials", message: "Wrong username or password." }), 0);
    expect(s.auth).toMatchObject({ user: null, pending: false, error: "Wrong username or password." });
  });

  it("characters_list and campaigns_list update the lists; logged_out clears everything", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("auth_ok", { user, characters: [] }), 0);
    applyServerMessage(s, msg("characters_list", { characters: [summary] }), 0);
    applyServerMessage(s, msg("campaigns_list", { campaigns: [{ save_id: "autosave", room_id: "room_1", kind: "autosave", name: "autosave", campaign_title: "T", updated_at: "x", players: ["Ana"], can_resume: true }] }), 0);
    expect(s.auth.characters[0]?.name).toBe("Ana");
    expect(s.auth.campaigns).toHaveLength(1);
    applyServerMessage(s, msg("logged_out", {}), 0);
    expect(s.auth.user).toBeNull();
    expect(s.auth.characters).toEqual([]);
    expect(s.auth.campaigns).toBeNull();
  });

  it("leaving a room keeps the login", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("auth_ok", { user, characters: [summary] }), 0);
    applyServerMessage(s, msg("joined", { player_id: "p1", auth_token: "t", room_id: "r" }), 0);
    resetRoom(s);
    expect(s.playerId).toBeNull();
    expect(s.auth.user?.username).toBe("ana");
    expect(s.auth.characters).toHaveLength(1);
  });

  it("lobby_state can carry a resume hint", () => {
    const s = createInitialState();
    applyServerMessage(s, msg("lobby_state", {
      room_id: "r", invite_code: "ABCDEF", host_player_id: "p1", phase: "lobby",
      settings: { content_rating: "teen", campaign_pitch: "", dev_solo: false }, players: [],
      resume_save: { save_id: "autosave", name: "autosave" },
    }), 0);
    expect(s.lobby?.resume_save?.save_id).toBe("autosave");
  });
});

describe("session token storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips through localStorage and rejects junk", () => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); },
    });
    expect(loadSessionToken()).toBeNull();
    saveSessionToken("abcdefghijkl");
    expect(loadSessionToken()).toBe("abcdefghijkl");
    saveSessionToken("x");
    expect(loadSessionToken()).toBeNull();
    saveSessionToken("abcdefghijkl");
    clearSessionToken();
    expect(loadSessionToken()).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => saveSessionToken("abcdefghijkl")).not.toThrow();
    expect(loadSessionToken()).toBeNull();
    expect(() => clearSessionToken()).not.toThrow();
  });
});
