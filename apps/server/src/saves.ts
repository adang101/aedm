import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GameState } from "@aedm/engine";
import type { RoomSettings } from "@aedm/schemas";
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
  };
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
