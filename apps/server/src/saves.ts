import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  summaries: string[];
  scene_note: string;
  /** Private DM notes. Never sent to clients. */
  dm_notes: string[];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeId = (s: string): boolean => SAFE_ID.test(s);

/** Writes atomically (temp file, then rename). */
export async function writeSave(dir: string, roomId: string, saveId: string, data: SaveFile): Promise<string> {
  if (!isSafeId(roomId) || !isSafeId(saveId)) throw new Error("unsafe save id");
  const roomDir = join(dir, roomId);
  await mkdir(roomDir, { recursive: true });
  const file = join(roomDir, `${saveId}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf8");
  await rename(tmp, file);
  return file;
}

/** Finds `<saveId>.json` in the room's folder first, then in any room folder. */
export async function readSave(dir: string, roomId: string, saveId: string): Promise<SaveFile | null> {
  if (!isSafeId(saveId)) return null;
  const candidates: string[] = [];
  if (isSafeId(roomId)) candidates.push(join(dir, roomId, `${saveId}.json`));
  try {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory() && isSafeId(d.name)) candidates.push(join(dir, d.name, `${saveId}.json`));
    }
  } catch {
    /* no save directory yet */
  }
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as SaveFile;
      if (parsed.v === SAVE_VERSION && parsed.state) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Reads exactly `<dir>/<roomId>/<saveId>.json`. */
export async function readSaveExact(dir: string, roomId: string, saveId: string): Promise<SaveFile | null> {
  if (!isSafeId(roomId) || !isSafeId(saveId)) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dir, roomId, `${saveId}.json`), "utf8")) as SaveFile;
    return parsed.v === SAVE_VERSION && parsed.state ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Saves owned by `userId`, newest first: per campaign the latest autosave plus every named save.
 * Scans the save folders (fine at this size; a database would index it).
 */
export async function listOwnedSaves(dir: string, userId: string): Promise<CampaignInfo[]> {
  const found: { info: CampaignInfo; campaign: string; saved: number }[] = [];
  let rooms: string[];
  try {
    rooms = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && isSafeId(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  for (const roomId of rooms) {
    let files: string[];
    try { files = (await readdir(join(dir, roomId))).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const saveId = f.slice(0, -".json".length);
      if (!isSafeId(saveId)) continue;
      const save = await readSaveExact(dir, roomId, saveId);
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
  }
  const newestAuto = new Map<string, number>();
  for (const f of found) if (f.info.kind === "autosave") newestAuto.set(f.campaign, Math.max(newestAuto.get(f.campaign) ?? 0, f.saved));
  return found
    .filter((f) => f.info.kind === "named" || newestAuto.get(f.campaign) === f.saved)
    .sort((a, b) => b.saved - a.saved)
    .slice(0, 100)
    .map((f) => f.info);
}
