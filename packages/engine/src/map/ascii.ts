import type { GameMap } from "@aedm/schemas";
import { getObjects, groundOf, wallsOf } from "./nav";
import { tileInfo } from "./tileset";

/**
 * Debug render. #=wall, T=tree, r=rock/dune, ~=water, B=building, .=floor, +=door,
 * S=start, E=exit, e=entity slot, c=interactable, t=trigger.
 */
export function renderAscii(map: GameMap): string {
  const walls = wallsOf(map);
  const ground = groundOf(map);
  const grid: string[][] = [];
  for (let y = 0; y < map.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < map.width; x++) {
      const i = y * map.width + x;
      const w = walls[i] ?? 0;
      if (w !== 0) {
        const name = tileInfo(w)?.name ?? "";
        row.push(name.startsWith("tree") ? "T" : name === "rock" || name === "dune" ? "r" : name === "water" ? "~" : name === "building_wall" ? "B" : "#");
      } else {
        row.push((tileInfo(ground[i] ?? 0)?.name ?? "").startsWith("door") ? "+" : ".");
      }
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
