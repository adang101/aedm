import { FsKv, type KvBackend } from "./kv";
import type { GameState } from "@aedm/engine";
import type { CampaignInfo, RoomSettings } from "@aedm/schemas";
import type { RecentTurn } from "./context";

export const SAVE_VERSION = 1;

export interface SaveFile {
  v: typeof SAVE_VERSION;
  name: string;
  saved_at: string;
  room: {
    room_id: string;
    invite_code: string;
    settings: RoomSettings;
    players: { player_id: string; display_name: string; character_id: string | null }[];
    /** player_id -> account id, for the seats that were logged in. */
    player_user_ids?: Record<string, string>;
  };
  /** The account that owns this campaign (the host's, at save time). Absent or null for guest rooms. */
  owner_user_id?: string | null;
  campaign_title?: string;
  state: GameState;
  turns: RecentTurn[];
  /** One compact summary of everything older than `chapters`. */
  story_so_far: string;
  /** Summaries of the most recent stretches of play, oldest first. */
  chapters: string[];
  scene_note: string;
  /** Private DM notes. Never sent to clients. */
  dm_notes: string[];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeId = (s: string): boolean => SAFE_ID.test(s);

const SAVE_KEY = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.json$/;
const saveKey = (roomId: string, saveId: string): string => `${roomId}/${saveId}.json`;

/** A save as stored: older files lack the newer fields and have `summaries` instead of `story_so_far` and `chapters`. */
type StoredSave = Omit<SaveFile, "story_so_far" | "chapters" | "state"> & {
  story_so_far?: string;
  chapters?: string[];
  /** Before tiered memory: a rolling list of cumulative summaries, newest last. */
  summaries?: string[];
  state: Omit<GameState, "threads"> & { threads?: GameState["threads"] };
};

/** Fills in what older saves lack: the last cumulative summary becomes the story so far, and threads start empty. */
function migrateSave({ summaries, ...save }: StoredSave): SaveFile {
  return {
    ...save,
    story_so_far: save.story_so_far ?? summaries?.at(-1) ?? "",
    chapters: save.chapters ?? [],
    state: { ...save.state, threads: save.state.threads ?? [] },
  };
}

function parseSave(text: string | null): SaveFile | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as StoredSave;
    return parsed.v === SAVE_VERSION && parsed.state ? migrateSave(parsed) : null;
  } catch {
    return null;
  }
}

/** Everything the server needs from save storage. */
export interface SaveStore {
  /** Replaces `<roomId>/<saveId>` atomically. */
  write(roomId: string, saveId: string, data: SaveFile): Promise<void>;
  /** Finds the save in the room's folder first, then in any room's. */
  read(roomId: string, saveId: string): Promise<SaveFile | null>;
  /** Exactly `<roomId>/<saveId>`. */
  readExact(roomId: string, saveId: string): Promise<SaveFile | null>;
  /** Saves owned by `userId`, newest first: per campaign the latest autosave plus every named save. */
  listOwned(userId: string): Promise<CampaignInfo[]>;
}

/** Saves as `<roomId>/<saveId>.json` values in any KvBackend (files on Node, Durable Object storage on Cloudflare). */
export class KvSaveStore implements SaveStore {
  constructor(private readonly kv: KvBackend) {}

  async write(roomId: string, saveId: string, data: SaveFile): Promise<void> {
    if (!isSafeId(roomId) || !isSafeId(saveId)) throw new Error("unsafe save id");
    await this.kv.put(saveKey(roomId, saveId), JSON.stringify(data));
  }

  async read(roomId: string, saveId: string): Promise<SaveFile | null> {
    if (!isSafeId(saveId)) return null;
    if (isSafeId(roomId)) {
      const own = parseSave(await this.kv.get(saveKey(roomId, saveId)));
      if (own) return own;
    }
    for (const key of await this.kv.list()) {
      const m = SAVE_KEY.exec(key);
      if (!m || m[2] !== saveId || m[1] === roomId) continue;
      const found = parseSave(await this.kv.get(key));
      if (found) return found;
    }
    return null;
  }

  async readExact(roomId: string, saveId: string): Promise<SaveFile | null> {
    if (!isSafeId(roomId) || !isSafeId(saveId)) return null;
    return parseSave(await this.kv.get(saveKey(roomId, saveId)));
  }

  /** Scans every save (fine at this size; a database would index it). */
  async listOwned(userId: string): Promise<CampaignInfo[]> {
    const found: { info: CampaignInfo; campaign: string; saved: number }[] = [];
    for (const key of await this.kv.list()) {
      const m = SAVE_KEY.exec(key);
      if (!m) continue;
      const [, roomId, saveId] = m as unknown as [string, string, string];
      const save = parseSave(await this.kv.get(key));
      if (!save || save.owner_user_id !== userId) continue;
      const savedMs = Date.parse(save.saved_at) || 0;
      const title = (save.campaign_title ?? save.state.bible?.title ?? "").slice(0, 80);
      found.push({
        campaign: save.state.campaignId ?? roomId,
        saved: savedMs,
        info: {
          save_id: saveId, room_id: roomId, kind: saveId === "autosave" ? "autosave" : "named",
          name: (save.name || saveId).slice(0, 30), campaign_title: title, updated_at: save.saved_at,
          players: save.room.players.map((p) => p.display_name.slice(0, 24)).slice(0, 6), can_resume: true,
        },
      });
    }
    const newestAuto = new Map<string, number>();
    for (const f of found) if (f.info.kind === "autosave") newestAuto.set(f.campaign, Math.max(newestAuto.get(f.campaign) ?? 0, f.saved));
    return found
      .filter((f) => f.info.kind === "named" || newestAuto.get(f.campaign) === f.saved)
      .sort((a, b) => b.saved - a.saved)
      .slice(0, 100)
      .map((f) => f.info);
  }
}

/** Saves as plain JSON files under `dir`. */
export const fsSaveStore = (dir: string): SaveStore => new KvSaveStore(new FsKv(dir, { fileMode: 0o644, dirMode: 0o755 }));
