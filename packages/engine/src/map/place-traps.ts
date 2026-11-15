/**
 * Trap objects (and optionally hidden chests) for a generated map. Everything here draws from its own seeded streams, never from
 * the map's main one, and runs after the layout, objects, hazards and decor are fixed, so a seed's existing layout is unchanged
 * apart from the added trap objects. Numbers are in `data/interact.json` (`traps.generated`, `chest.hiddenPct`).
 */
import type { MapObject } from "@aedm/schemas";
import { INTERACT } from "../data.ts";
import { hashSeed } from "../rng.ts";
import { Grid, T, isPassable, level } from "./layouts/grid";
import type { Pt } from "./layouts/grid";
import { MapRng } from "./prng";

const tierKey = (tier: number): string => String(Math.min(5, Math.max(1, Math.trunc(tier) || 1)));

/**
 * Adds trap objects to `objects`: `traps.generated.countByHazardLevel` for the setting's hazard density, each on a floor tile the
 * party can reach without crossing a hazard, at least `minSpawnDistance` tiles from the start, away from every other object, exit,
 * door, hazard and decor tile, and not next to another trap. `hiddenPct` of them are hidden. DC and dice come from the loot tier.
 * `decorTiles` are the grid indices that carry a prop. Returns how many were added.
 */
export function placeTraps(grid: Grid, objects: MapObject[], start: Pt, hazardDensity: number, decorTiles: ReadonlySet<number>, seed: number, tier: number): number {
  const cfg = INTERACT.traps;
  const count = cfg.generated.countByHazardLevel[String(level(hazardDensity))] ?? 0;
  if (count <= 0) return 0;
  const rng = new MapRng(hashSeed(seed, "traps"));
  const seen = grid.reachable(start, (c) => isPassable(c) && c !== T.HAZARD);
  const used = new Set(objects.map((o) => `${o.x},${o.y}`));
  const pool: number[] = [];
  for (let i = 0; i < grid.t.length; i++) {
    const x = i % grid.w;
    const y = (i - x) / grid.w;
    if (grid.t[i] !== T.FLOOR || !seen[i] || grid.crit[i] || grid.border(x, y) || decorTiles.has(i) || used.has(`${x},${y}`)) continue;
    if (Math.max(Math.abs(x - start.x), Math.abs(y - start.y)) < cfg.generated.minSpawnDistance) continue;
    pool.push(i);
  }
  const placed: Pt[] = [];
  let added = 0;
  while (added < count && pool.length > 0) {
    const at = rng.int(0, pool.length - 1);
    const i = pool[at] as number;
    pool[at] = pool[pool.length - 1] as number;
    pool.pop();
    const p = { x: i % grid.w, y: Math.floor(i / grid.w) };
    if (placed.some((q) => Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) < 2)) continue;
    const dc = Math.min(30, Math.max(5, (cfg.dcByTier[tierKey(tier)] ?? 12) + rng.int(-cfg.variance, cfg.variance)));
    const hidden = rng.int(1, 100) <= cfg.generated.hiddenPct;
    const damageType = rng.pick(cfg.damageTypes) as "sharp";
    added++;
    placed.push(p);
    objects.push({
      type: "interactable", id: `trap_${added}`, kind: "trap", state: "closed", x: p.x, y: p.y,
      ...(hidden ? { hidden: true } : {}),
      trap: { dc, dice: cfg.diceByTier[tierKey(tier)] ?? "1d6", damage_type: damageType },
    });
  }
  return added;
}

/** Hides `chest.hiddenPct` percent of the chests (a stream of its own; nothing is drawn when the percent is 0). */
export function hideChests(objects: MapObject[], seed: number): void {
  const pct = INTERACT.chest.hiddenPct;
  if (pct <= 0) return;
  const rng = new MapRng(hashSeed(seed, "hidden-chests"));
  objects.forEach((o, i) => {
    if (o.type === "interactable" && o.kind === "chest" && rng.int(1, 100) <= pct) objects[i] = { ...o, hidden: true };
  });
}
