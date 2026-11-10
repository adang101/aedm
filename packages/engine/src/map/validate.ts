import type { GameMap, TileDef } from "@aedm/schemas";
import { getObjects, groundOf, key, serializeSize, wallsOf } from "./nav";

export const MAX_MAP_BYTES = 250 * 1024;

export interface MapValidation {
  ok: boolean;
  errors: string[];
  /** Not failures: tile definitions nothing draws, and so on. */
  warnings: string[];
}

/**
 * The 7 rules from docs/contracts.md "Map JSON" (rule 2 is the inline tileset covering every tile id), plus
 * rule 8: every exit, entity slot and interactable can be reached from `party_start` without stepping on a
 * hazard tile. Returns every failure found; unused tile definitions are warnings.
 */
export function validateMap(map: GameMap): MapValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
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

  // 2. every non-zero tile id has a TileDef in the inline tileset
  const defs = new Map(map.tileset.tiles.map((t) => [t.gid, t]));
  const usedGids = new Set<number>();
  for (const l of layers) {
    let bad = 0;
    let last = 0;
    for (const v of l.data) {
      if (v === 0 || v === last) continue;
      last = v;
      usedGids.add(v);
      if (!defs.has(v)) bad++;
    }
    if (bad > 0) errors.push(`rule 2: layer ${l.name} has ${bad} tile id(s) without a TileDef`);
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
    const seen = new Uint8Array(w * h);
    seen[start.y * w + start.x] = 1;
    const stack = [start.y * w + start.x];
    while (stack.length > 0) {
      const c = stack.pop()!;
      const cx = c % w;
      const cy = (c - cx) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!open(nx, ny)) continue;
          const n = ny * w + nx;
          if (!seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    for (const o of objects) {
      if (o.type === "exit" || o.type === "entity_slot" || o.type === "interactable") {
        if (!inB(o.x, o.y) || !seen[o.y * w + o.x]) {
          const label = o.type === "exit" ? o.name : o.id;
          errors.push(`rule 4: ${o.type} ${label} at ${o.x},${o.y} is not reachable from party_start`);
        }
      }
    }
  }

  // 8. hazards are never the only way through
  if (start && open(start.x, start.y)) {
    const isHazard = (x: number, y: number) => defs.get(ground[y * w + x] ?? 0)?.role === "hazard";
    const clear = (x: number, y: number) => open(x, y) && !isHazard(x, y);
    if (!clear(start.x, start.y)) errors.push(`rule 8: party_start at ${start.x},${start.y} is on a hazard tile`);
    else {
      const seen = new Uint8Array(w * h);
      seen[start.y * w + start.x] = 1;
      const stack = [start.y * w + start.x];
      while (stack.length > 0) {
        const c = stack.pop()!;
        const cx = c % w;
        const cy = (c - cx) / w;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!clear(nx, ny)) continue;
            const n = ny * w + nx;
            if (!seen[n]) { seen[n] = 1; stack.push(n); }
          }
        }
      }
      for (const o of objects) {
        if ((o.type === "exit" || o.type === "entity_slot" || o.type === "interactable") && inB(o.x, o.y) && !seen[o.y * w + o.x]) {
          errors.push(`rule 8: ${o.type} ${o.type === "exit" ? o.name : o.id} at ${o.x},${o.y} needs a path across a hazard`);
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
    const isDoor = defs.get(ground[o.y * w + o.x] ?? 0)?.role === "door";
    if (!onBoundary && !isDoor) errors.push(`rule 6: exit ${o.name} at ${o.x},${o.y} is neither on the boundary nor a door tile`);
  }

  // 7. size
  const bytes = serializeSize(map);
  if (bytes > MAX_MAP_BYTES) errors.push(`rule 7: serialized map is ${bytes} bytes (max ${MAX_MAP_BYTES})`);

  // unused tile definitions
  const orphans = map.tileset.tiles.filter((t) => !usedGids.has(t.gid));
  if (orphans.length > 0) warnings.push(`${orphans.length} tile definition(s) are not used by any layer: ${orphans.slice(0, 5).map((t) => t.gid).join(", ")}`);

  return { ok: errors.length === 0, errors, warnings };
}

/** Drops tile definitions no layer uses and renumbers the rest densely (gids in layers are remapped). Pure. */
export function stripOrphanTiles(map: GameMap): GameMap {
  const used = new Set<number>();
  for (const l of map.layers) if (l.type === "tilelayer") for (const v of l.data) if (v !== 0) used.add(v);
  const remap = new Map<number, number>();
  const tiles: TileDef[] = [];
  for (const t of map.tileset.tiles) {
    if (!used.has(t.gid)) continue;
    remap.set(t.gid, tiles.length + 1);
    tiles.push({ ...t, gid: tiles.length + 1 });
  }
  if (tiles.length === map.tileset.tiles.length || tiles.length === 0) return map;
  return {
    ...map,
    tileset: { first_gid: 1, tiles },
    layers: map.layers.map((l) => (l.type === "tilelayer" ? { ...l, data: l.data.map((v) => (v === 0 ? 0 : (remap.get(v) ?? 0))) } : l)),
  };
}
