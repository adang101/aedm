import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS_VERSION, type ServerMessage } from "@aedm/schemas";
import { GameClient } from "./client";
import { Store } from "../state/store";
import { loadSessionToken, saveSessionToken } from "../state/storage";
import type { TransportHandlers } from "./transport";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

function setup() {
  const sent: { type: string; id: string; payload: Record<string, unknown> }[] = [];
  let handlers: TransportHandlers | null = null;
  const store = new Store();
  const notes: string[] = [];
  const client = new GameClient(store, (h) => {
    handlers = h;
    return { send: (raw) => { sent.push(JSON.parse(raw)); }, close: () => undefined };
  }, { notify: (m) => { notes.push(m); } });
  const reply = <T extends ServerMessage["type"]>(type: T, payload: unknown, ack?: string) =>
    handlers?.onMessage(JSON.stringify({ v: WS_VERSION, type, id: `s${Math.random()}`, ts: 0, payload, ...(ack ? { ack_id: ack } : {}) }));
  return { client, store, sent, notes, open: () => handlers?.onOpen(), reply, types: () => sent.map((m) => m.type) };
}

const user = { id: "u_1", username: "ana", display_name: "Ana" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GameClient accounts", () => {
  it("resumes the stored session on connect and holds create_room until the account is bound", () => {
    saveSessionToken("stored-session-token");
    const t = setup();
    t.client.connect();
    t.open();
    expect(t.types()).toEqual(["resume_session"]);
    expect(t.sent[0]?.payload).toEqual({ session_token: "stored-session-token" });

    t.client.host("Ana"); // clicked before the reply arrived
    expect(t.types()).toEqual(["resume_session"]);
    t.reply("auth_ok", { user, characters: [] }, t.sent[0]?.id);
    expect(t.store.state.auth.user?.username).toBe("ana");
    expect(t.types()).toEqual(["resume_session", "create_room"]);

    t.reply("room_created", { room_id: "r1", invite_code: "ABCDEF" });
    expect(t.types().at(-1)).toBe("join_room");
  });

  it("reuses the open connection for hosting and does not re-create the room on reconnect", () => {
    const t = setup();
    t.client.connect();
    t.open();
    expect(t.types()).toEqual([]); // no stored session: nothing to send yet
    t.client.host("Guest");
    expect(t.types()).toEqual(["create_room"]);
    t.reply("room_created", { room_id: "r1", invite_code: "ABCDEF" });
    t.reply("joined", { player_id: "p1", auth_token: "tok", room_id: "r1" });
    t.sent.length = 0;
    t.open(); // reconnect
    expect(t.types()).toEqual(["join_room"]);
  });

  it("forgets a stale stored session quietly", () => {
    saveSessionToken("expired-token-123");
    const t = setup();
    t.client.connect();
    t.open();
    t.reply("auth_error", { code: "invalid_credentials", message: "Your session has expired." }, t.sent[0]?.id);
    expect(loadSessionToken()).toBeNull();
    expect(t.store.state.auth.user).toBeNull();
    expect(t.store.state.auth.error).toBeNull();
  });

  it("stores the token from register and clears it on logout", () => {
    const t = setup();
    t.client.connect();
    t.open();
    t.client.register("ana", "long-enough-pw", "Ana");
    expect(t.store.state.auth.pending).toBe(true);
    expect(t.sent[0]).toMatchObject({ type: "register", payload: { username: "ana", display_name: "Ana" } });
    t.reply("auth_ok", { user, session_token: "fresh-session-token", characters: [] }, t.sent[0]?.id);
    expect(t.store.state.auth.pending).toBe(false);
    expect(loadSessionToken()).toBe("fresh-session-token");

    t.client.logout();
    expect(loadSessionToken()).toBeNull();
    expect(t.sent.at(-1)?.type).toBe("logout");
    t.reply("logged_out", {});
    expect(t.store.state.auth.user).toBeNull();
  });

  it("an auth_error shows on the login form and a failed account action does not kick the client out", () => {
    const t = setup();
    t.client.connect();
    t.open();
    t.client.login("ana", "wrong-password");
    t.reply("auth_error", { code: "invalid_credentials", message: "Wrong username or password." }, t.sent[0]?.id);
    expect(t.store.state.auth.error).toBe("Wrong username or password.");
    expect(t.store.state.auth.pending).toBe(false);

    t.client.send("list_campaigns", {});
    t.reply("error", { code: "forbidden", message: "Log in to do that.", ack_id: t.sent.at(-1)?.id }, t.sent.at(-1)?.id);
    expect(t.store.state.conn).toBe("open");
    expect(t.notes).toContain("Log in to do that.");
  });
});

describe("GameClient sprite designer", () => {
  const spec = {
    kind: "spec", v: 1, body: "avian", size: "medium", glyph: "H", traits: "", parts: [],
    palette: { primary: "#112233", secondary: "#445566", accent: "#778899", detail: "#001122" },
  };

  it("sends design_sprite and hands the reply to afterReply with its payload", () => {
    const t = setup();
    t.client.connect();
    t.open();
    const id = t.client.send("design_sprite", { prompt: "a heron-folk ferryman", role_hint: "pc", seed: 3 });
    expect(id).not.toBeNull();
    expect(t.types()).toContain("design_sprite");
    let got: ServerMessage | null = null;
    t.client.afterReply(id as string, (_type, msg) => { got = msg; });
    t.reply("sprite_designed", { spec, notes: [], source: "offline" }, id as string);
    expect((got as ServerMessage | null)?.type).toBe("sprite_designed");
  });

  it("refuses to send an over-long prompt", () => {
    const t = setup();
    t.client.connect();
    t.open();
    expect(t.client.send("design_sprite", { prompt: "x".repeat(301), role_hint: "pc" })).toBeNull();
    expect(t.types()).not.toContain("design_sprite");
  });
});
