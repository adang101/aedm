import { cloneState, isWalkable, occupiedTiles, type GameState } from "@aedm/engine";
import type { MapObject } from "@aedm/schemas";
import type { Harness, Table } from "./helpers";

export const gameOf = (h: Harness) => h.server.rooms.all()[0]!.game!;
export const stateOf = (h: Harness): GameState => gameOf(h).state;

/** What a test needs to know about the open strip it stages: three rows of floor (y - 1, y, y + 1), `RUN` tiles long from x0. */
export interface Stage { a: string; b: string; mapId: string; x0: number; y: number }
export const RUN = 14;

export const trapObj = (id: string, x: number, y: number, extra: Record<string, unknown> = {}): MapObject =>
  ({ type: "interactable", id, kind: "trap", state: "closed", x, y, trap: { dc: 10, dice: "2d6", damage_type: "sharp" }, ...extra }) as unknown as MapObject;
export const obj = (o: Record<string, unknown>): MapObject => ({ type: "interactable", ...o }) as unknown as MapObject;

/**
 * Put both characters at the start of an open strip of floor, strip the map of the traps the generator placed (so a test is not at
 * the mercy of the seed), and add `objects`. Returns the strip. `seal` walls in the rows above and below the strip and its far end,
 * which makes it a corridor with a single way through.
 */
export function stageRun(h: Harness, t: Table, opts: { objects?: (s: Stage) => MapObject[]; seal?: boolean; edit?: (st: GameState, s: Stage) => void } = {}): Stage {
  const game = gameOf(h);
  const st = cloneState(game.state);
  const a = t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id === t.a.playerId)!.id;
  const b = t.a.lastSnapshot()!.entities.find((e) => e.kind === "pc" && e.owner_player_id !== t.a.playerId)!.id;
  const mapId = st.currentMapId!;
  const map = structuredClone(st.maps[mapId]!);
  const occ = occupiedTiles(st, mapId, { includeWalls: false });
  for (const id of [a, b]) occ.delete(`${st.entities[id]!.x},${st.entities[id]!.y}`);
  let found: { x0: number; y: number } | undefined;
  for (let y = 2; y < map.height - 2 && !found; y++) {
    for (let x0 = 2; x0 < map.width - RUN - 2 && !found; x0++) {
      let ok = true;
      for (let dx = -1; dx <= RUN && ok; dx++) for (let dy = -2; dy <= 2 && ok; dy++) if (!isWalkable(map, x0 + dx, y + dy) || occ.has(`${x0 + dx},${y + dy}`)) ok = false;
      if (ok) found = { x0, y };
    }
  }
  if (!found) {
    // natural maps rarely have a bare strip this size, so clear one: the spot with the fewest blocked tiles that holds no object or creature
    const objectTiles = new Set(map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects.map((o) => `${o.x},${o.y}`) : [])));
    let best: { x0: number; y: number; blocked: number } | undefined;
    for (let y = 3; y < map.height - 3; y++) {
      for (let x0 = 3; x0 < map.width - RUN - 3; x0++) {
        let blocked = 0;
        let free = true;
        for (let dx = -1; dx <= RUN && free; dx++) for (let dy = -2; dy <= 2 && free; dy++) {
          const k = `${x0 + dx},${y + dy}`;
          if (occ.has(k) || objectTiles.has(k)) free = false;
          else if (!isWalkable(map, x0 + dx, y + dy)) blocked++;
        }
        if (free && (!best || blocked < best.blocked)) best = { x0, y, blocked };
      }
    }
    if (!best) throw new Error("no room for an open strip on the test map");
    for (const l of map.layers) {
      if (l.type !== "tilelayer" || (l.name !== "walls" && l.name !== "above")) continue;
      for (let dx = -1; dx <= RUN; dx++) for (let dy = -2; dy <= 2; dy++) l.data[(best.y + dy) * map.width + best.x0 + dx] = 0;
    }
    found = { x0: best.x0, y: best.y };
  }
  const s: Stage = { a, b, mapId, ...found };
  for (const l of map.layers) {
    if (l.type === "objectgroup") {
      l.objects = l.objects.filter((o) => !(o.type === "interactable" && o.kind === "trap"));
      l.objects.push(...(opts.objects?.(s) ?? []));
    }
    if (l.type === "tilelayer" && l.name === "walls" && opts.seal) {
      for (let dx = 0; dx <= RUN; dx++) { l.data[(s.y - 1) * map.width + s.x0 + dx] = 1; l.data[(s.y + 1) * map.width + s.x0 + dx] = 1; }
      for (let dy = -1; dy <= 1; dy++) l.data[(s.y + dy) * map.width + s.x0 + RUN] = 1;
    }
  }
  st.maps[mapId] = map;
  st.entities[a]!.x = s.x0; st.entities[a]!.y = s.y;
  st.entities[b]!.x = opts.seal ? s.x0 - 1 : s.x0;
  st.entities[b]!.y = opts.seal ? s.y : s.y - 1;
  opts.edit?.(st, s);
  game.state = st;
  return s;
}

/** Send the current snapshot to everyone (a reconnect gets the same thing), so a test can read what a client holds. */
export function resend(h: Harness): void {
  gameOf(h).broadcastSnapshot();
}

/** Make the next engine call that `pick` runs come out as `want`: finds a rng seed in the state for which the pure call has that outcome. */
export function rig(h: Harness, pick: (copy: GameState) => boolean, want = true): void {
  const game = gameOf(h);
  for (let seed = 1; seed < 2000; seed++) {
    const copy = cloneState(game.state);
    copy.rngState = seed;
    if (pick(copy) === want) { game.state.rngState = seed; return; }
  }
  throw new Error("no rng seed gives that outcome");
}

/** Every JSON message a client received, as one string (what the table could read). */
export const wire = (c: { msgs: readonly unknown[] }, from = 0): string => c.msgs.slice(from).map((m) => JSON.stringify(m)).join(" ");
