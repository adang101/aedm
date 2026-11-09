import type { GameMap } from "@aedm/schemas";
import { getObjects, groundOf, key, serializeSize, wallsOf } from "./nav";
import { TILESET_BLOCKS, TILESET_BLOCKS_COUNT, tileInfo } from "./tileset";

export const MAX_MAP_BYTES = 250 * 1024;

const FALLBACK_TILESET_SIZE = 1024;

/** The 7 rules from docs/contracts.md "Map JSON". Returns every failure found. */
export function validateMap(map: GameMap): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const { width: w, height: h } = map;
  const layers = map.layers.filter((l) => l.type === "tilelayer");

  // 1. data lengths
  let lengthsOk = true;
  for (const l of layers) {
    if (l.data.length !== w * h) {
      lengthsOk = false;
      errors.push(`rule 1: layer ${l.name} data length ${l.data.length} != ${w * h}`);
    }
  }

  // 2. tile ids inside a tileset range
  const sets = [...map.tilesets].sort((a, b) => a.first_gid - b.first_gid);
  const ranges = sets.map((t, i) => {
    const size = t.asset_id === TILESET_BLOCKS.asset_id ? TILESET_BLOCKS_COUNT : FALLBACK_TILESET_SIZE;
    const next = sets[i + 1]?.first_gid ?? Infinity;
    return [t.first_gid, Math.min(t.first_gid + size - 1, next - 1)] as const;
  });
  for (const l of layers) {
    let bad = 0;
    for (const v of l.data) if (v !== 0 && !ranges.some(([lo, hi]) => v >= lo && v <= hi)) bad++;
    if (bad > 0) errors.push(`rule 2: layer ${l.name} has ${bad} tile id(s) outside every tileset range`);
  }

  const objects = getObjects(map);
  const walls = wallsOf(map);
  const ground = groundOf(map);
  const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  const open = (x: number, y: number) => inB(x, y) && lengthsOk && (walls[y * w + x] ?? 0) === 0;

  for (const o of objects) {
    if (!inB(o.x, o.y)) errors.push(`object at ${o.x},${o.y} is outside the map`);
  }

  // 3. party_start walkable
  const starts = objects.filter((o) => o.type === "spawn" && o.name === "party_start");
  const start = starts[0];
  if (starts.length !== 1 || !start) errors.push(`rule 3: expected exactly one party_start, found ${starts.length}`);
  else if (!open(start.x, start.y)) errors.push(`rule 3: party_start at ${start.x},${start.y} is not walkable`);

  // 4. flood fill reachability
  if (start && open(start.x, start.y)) {
    const seen = new Set<number>([start.y * w + start.x]);
    const stack = [start.y * w + start.x];
    while (stack.length > 0) {
      const c = stack.pop()!;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!open(nx, ny)) continue;
          const n = ny * w + nx;
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
    }
    for (const o of objects) {
      if (o.type === "exit" || o.type === "entity_slot" || o.type === "interactable") {
        if (!inB(o.x, o.y) || !seen.has(o.y * w + o.x)) {
          const label = o.type === "exit" ? o.name : o.id;
          errors.push(`rule 4: ${o.type} ${label} at ${o.x},${o.y} is not reachable from party_start`);
        }
      }
    }
  }

  // 5. no shared tiles
  const taken = new Map<string, string>();
  for (const o of objects) {
    const k = key(o.x, o.y);
    const label = `${o.type}:${"id" in o ? o.id : o.name}`;
    const other = taken.get(k);
    if (other) errors.push(`rule 5: ${label} and ${other} share tile ${k}`);
    else taken.set(k, label);
  }

  // 6. exits walkable and on the boundary or a door tile
  for (const o of objects) {
    if (o.type !== "exit") continue;
    if (!open(o.x, o.y)) {
      errors.push(`rule 6: exit ${o.name} at ${o.x},${o.y} is not on a walkable tile`);
      continue;
    }
    const onBoundary = o.x === 0 || o.y === 0 || o.x === w - 1 || o.y === h - 1;
    const isDoor = (tileInfo(ground[o.y * w + o.x] ?? 0)?.name ?? "").startsWith("door");
    if (!onBoundary && !isDoor) errors.push(`rule 6: exit ${o.name} at ${o.x},${o.y} is neither on the boundary nor a door tile`);
  }

  // 7. size
  const bytes = serializeSize(map);
  if (bytes > MAX_MAP_BYTES) errors.push(`rule 7: serialized map is ${bytes} bytes (max ${MAX_MAP_BYTES})`);

  return { ok: errors.length === 0, errors };
}
