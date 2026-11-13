/** Plain-text renderings of abilities and of the cost model, for prompts. Pure; numbers come from the data. */
import type { Ability, Effect } from "@aedm/schemas";
import { COSTS, type Costs } from "./data.ts";

/** Hundredths as a multiplier: 150 -> "x1.5". Display only; cost math stays in integers. */
const mult = (hundredths: number): string => `x${hundredths / 100}`;
const turns = (n: number): string => `${n}t`;

function shapeText(e: { shape?: string; radius_tiles?: number }): string {
  if (e.shape === "burst") return ` burst r${e.radius_tiles ?? 1}`;
  return e.shape === "line" || e.shape === "cone" ? ` ${e.shape}` : "";
}

function effectSummary(e: Effect): string {
  switch (e.type) {
    case "damage": return `${e.dice} ${e.damage_type} damage${shapeText(e)}`;
    case "heal": return `${e.dice} heal${shapeText(e)}`;
    case "shield": return `shield ${e.absorb} for ${turns(e.duration_turns)}`;
    case "condition": return `${e.condition} ${turns(e.duration_turns)}`;
    case "mark": return `mark ${turns(e.duration_turns)}`;
    case "push":
    case "pull":
    case "dash":
    case "teleport": return `${e.type} ${e.tiles} tiles`;
    case "reveal": return `reveal r${e.radius_tiles}`;
    case "disarm": return "disarm";
    case "terrain": return `${e.kind}${shapeText(e)}${e.dice ? ` ${e.dice} damage` : ""}`;
    case "check_bonus": return `+${e.bonus} ${e.tags.join("/")} checks`;
  }
}

/** One line a player or the forge can read: effects, range and frequency. */
export function abilitySummary(a: Ability): string {
  const freq = a.uses_per_rest !== undefined ? `${a.uses_per_rest} use(s) per rest` : a.cooldown_turns ? `cooldown ${a.cooldown_turns}` : "no cooldown";
  return `${a.effects.map(effectSummary).join(", ")}; range ${a.range_tiles}; ${freq}`;
}

/** A short guide to what makes an ability expensive, rendered from the cost data. */
export function abilityCostGuide(costs: Costs = COSTS): string {
  const cond = Object.entries(costs.conditionPerTurn).sort((x, y) => y[1] - x[1]);
  const [priciest, cheapest] = [cond[0], cond[cond.length - 1]] as [[string, number], [string, number]];
  const dur = costs.durationMultipliers;
  const ranges = costs.range.map((r) => `up to ${r.maxTiles} ${mult(r.mult)}`).join(", ");
  const lastCd = String(costs.cooldownMaxKey);
  return [
    "Cost is the sum of the effects' prices, scaled by area, range, saves and how often it can be used.",
    `- Damage and healing: about 1 point per ${costs.damagePriceDivisor} average damage (heals per ${costs.healPriceDivisor}). Bigger dice cost the most.`,
    `- Conditions are priced per turn (${priciest[0]} ${priciest[1]}, down to ${cheapest[0]} ${cheapest[1]}); a duration of 2 turns is ${mult(dur["2"] as number)}, 3 turns is ${mult(dur["3"] as number)}.`,
    `- Area: single target ${mult(costs.area.single)}, burst radius 1 ${mult(costs.area.burst1)}, radius 2 ${mult(costs.area.burst2)}, line or cone ${mult(costs.area.line)}.`,
    `- Range in tiles: ${ranges}.`,
    `- A saving throw for the target ${mult(costs.save.save)}.`,
    `- Use: usable every turn ${mult(costs.cooldown["0"] as number)}; cooldown of ${lastCd} turns ${mult(costs.cooldown[lastCd] as number)}; 1 use per rest ${mult(costs.uses["1"] as number)}.`,
    "Trade area, duration, range or uses before cutting the core effect.",
  ].join("\n");
}
