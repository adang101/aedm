import type { ClientMessage } from "@aedm/schemas";
import type { Conn } from "../net";
import type { Deps } from "../types";

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

const TYPES = new Set<ClientMessage["type"]>(["save_sprite_asset", "delete_sprite_asset", "list_sprite_assets"]);

/** The Workshop: an account's sprite library. Guests get a clear error. */
export class WorkshopHandlers {
  constructor(private readonly deps: Deps) {}

  handles(type: ClientMessage["type"]): boolean {
    return TYPES.has(type);
  }

  async dispatch(conn: Conn, msg: ClientMessage): Promise<void> {
    const userId = conn.userId;
    if (!userId) return conn.error("forbidden", "Log in to use your Workshop.", msg.id);
    const store = this.deps.workshop;
    switch (msg.type) {
      case "list_sprite_assets":
        break;
      case "save_sprite_asset": {
        const { id, ...input } = (msg as Msg<"save_sprite_asset">).payload;
        const r = await store.save(userId, input, id);
        if (!r.ok) return conn.error(r.code === "invalid_sprite" ? "invalid_sprite" : r.code === "not_found" ? "not_found" : "invalid_state", r.message, msg.id);
        break;
      }
      case "delete_sprite_asset": {
        const ok = await store.delete(userId, (msg as Msg<"delete_sprite_asset">).payload.id);
        if (!ok) return conn.error("not_found", "No such Workshop sprite.", msg.id);
        break;
      }
      default: return;
    }
    conn.send("sprite_assets_list", await store.list(userId), msg.id);
  }
}
