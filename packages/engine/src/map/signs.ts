/** Sign text: a deterministic pick from the templates in `data/interact.json`, filled in with the setting and room type. */
import { INTERACT } from "../data.ts";
import { SIGN_TEXT_MAX } from "@aedm/schemas";

/**
 * Text for a sign in a place called `settingName`, optionally in a room of `roomType` ("hall", "chamber"...). Templates for
 * the room type, when there are any, are mixed with the default ones. `pick` must be a seeded draw (`rng.pick`-like).
 * `{setting}` becomes the setting's name in lower case and `{room}` the room type. At most 200 characters.
 */
export function signText(settingName: string, roomType: string | undefined, pick: <T>(arr: readonly T[]) => T): string {
  const t = INTERACT.signs.templates;
  const pool = [...(roomType ? (t[roomType] ?? []) : []), ...(t.default ?? [])];
  const template = pick(pool);
  const text = template.replaceAll("{setting}", settingName.trim().toLowerCase() || "place").replaceAll("{room}", roomType ?? "room");
  return text.slice(0, SIGN_TEXT_MAX).trim();
}
