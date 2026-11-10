import type { Ability, AbilityScoreKey, Effect } from "@aedm/schemas";

/** Plain-words helpers for ability cards and the character sheet. Pure; no DOM. */

export const SCORE_KEYS: readonly AbilityScoreKey[] = ["str", "dex", "con", "int", "wis", "cha"];
export const SCORE_NAMES: Record<AbilityScoreKey, string> = {
  str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma",
};

/** Mirrors the engine: floor((score - 10) / 2). */
export function modifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const pretty = (s: string): string => s.replace(/_/g, " ");

function area(e: { shape?: string; radius_tiles?: number; length_tiles?: number }): string {
  switch (e.shape) {
    case "burst": return ` in a burst of radius ${e.radius_tiles ?? 1}`;
    case "line": return ` in a line ${plural(e.length_tiles ?? 1, "tile")} long`;
    case "cone": return ` in a cone ${plural(e.length_tiles ?? 1, "tile")} long`;
    case "tile": return " on a tile";
    default: return " to one target";
  }
}

function who(affects: string | undefined): string {
  return affects === "allies" ? " (allies only)" : affects === "enemies" ? " (enemies only)" : affects === "all" ? " (everyone)" : "";
}

/** One effect in plain words. */
export function describeEffect(e: Effect): string {
  switch (e.type) {
    case "damage": {
      const save = e.save ? ` ${e.save.ability.toUpperCase()} save for ${e.on_save === "half" ? "half damage" : "no damage"}.` : "";
      return `Deals ${e.dice} ${pretty(e.damage_type)} damage${area(e)}${who(e.affects)}.${save}`;
    }
    case "heal": return `Heals ${e.dice}${area(e)}${who(e.affects)}.`;
    case "shield": return `Shields for ${e.absorb} damage for ${plural(e.duration_turns, "turn")}${who(e.affects)}.`;
    case "condition": {
      const when = e.on === "hit" ? "on a hit" : e.on === "failed_save" ? `if the target fails a ${(e.save?.ability ?? "wis").toUpperCase()} save` : "always";
      return `Makes the target ${pretty(e.condition)} for ${plural(e.duration_turns, "turn")} (${when})${who(e.affects)}.`;
    }
    case "push": return `Pushes the target ${plural(e.tiles, "tile")} away.`;
    case "pull": return `Pulls the target ${plural(e.tiles, "tile")} closer.`;
    case "dash": return `Dashes up to ${plural(e.tiles, "tile")}${e.with_attack ? " and attacks" : ""}.`;
    case "teleport": return `Teleports up to ${plural(e.tiles, "tile")}.`;
    case "mark": return `Marks the target for ${plural(e.duration_turns, "turn")}.`;
    case "reveal": return `Reveals hidden things within ${plural(e.radius_tiles, "tile")}.`;
    case "disarm": return "Disarms a trap or device.";
    case "terrain": {
      const dmg = e.dice ? `, dealing ${e.dice} ${pretty(e.damage_type ?? "")} damage`.replace("  ", " ") : "";
      const dur = e.duration_turns ? ` for ${plural(e.duration_turns, "turn")}` : "";
      return `Creates ${pretty(e.kind)}${area(e).replace(" to one target", "")}${dur}${dmg}.`;
    }
    case "check_bonus": return `+${e.bonus} on ${e.tags.join(" and ")} checks for ${plural(e.duration_turns, "turn")}${who(e.affects)}.`;
  }
}

export interface AbilityDescription {
  /** "Action - range 5 - cooldown 2 turns - cost 6" */
  header: string;
  effects: string[];
  tags: string[];
}

export function describeAbility(a: Ability): AbilityDescription {
  const parts: string[] = [a.action === "quick" ? "Quick action" : "Action"];
  parts.push(a.target === "self" ? "self" : a.target === "tile" ? `tile, range ${a.range_tiles}` : `${a.target}, range ${a.range_tiles}`);
  if (a.uses_per_rest !== undefined) parts.push(`${plural(a.uses_per_rest, "use")} per rest`);
  else if (a.cooldown_turns) parts.push(`cooldown ${plural(a.cooldown_turns, "turn")}`);
  if (a.cost !== undefined) parts.push(`cost ${a.cost}`);
  return { header: parts.join(" - "), effects: a.effects.map(describeEffect), tags: [...a.tags] };
}
