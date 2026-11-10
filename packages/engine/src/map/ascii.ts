import type { GameMap, TileDef } from "@aedm/schemas";
import { getObjects, groundOf, wallsOf } from "./nav";

/**
 * Debug render by tile role. #=wall, T=obstacle, ~=liquid, ^=hazard, +=door, .=floor, :=path, d=decor,
 * S=start, E=exit, e=entity slot, c=interactable, t=trigger.
 */
export function renderAscii(map: GameMap): string {
  const defs = new Map<number, TileDef>(map.tileset.tiles.map((t) => [t.gid, t]));
  const walls = wallsOf(map);
  const ground = groundOf(map);
  const decor = map.layers.find((l) => l.type === "tilelayer" && l.name === "decor");
  const decorData = decor && decor.type === "tilelayer" ? decor.data : [];
  const grid: string[][] = [];
  for (let y = 0; y < map.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < map.width; x++) {
      const i = y * map.width + x;
      const wall = defs.get(walls[i] ?? 0);
      const floor = defs.get(ground[i] ?? 0);
      let c = ".";
      if (wall) c = wall.role === "wall" ? "#" : wall.role === "liquid" ? "~" : "T";
      else if (floor?.role === "hazard") c = "^";
      else if (floor?.role === "door") c = "+";
      else if ((decorData[i] ?? 0) !== 0) c = "d";
      else if (floor?.role === "liquid") c = "~";
      else if (floor?.role === "path") c = ":";
      row.push(c);
    }
    grid.push(row);
  }
  const mark = { spawn: "S", exit: "E", entity_slot: "e", interactable: "c", trigger: "t" } as const;
  for (const o of getObjects(map)) {
    const row = grid[o.y];
    if (row && o.x < row.length) row[o.x] = mark[o.type];
  }
  return grid.map((r) => r.join("")).join("\n");
}
