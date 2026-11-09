import type { Condition, DamageType, Difficulty } from "@aedm/schemas";

/** Narratable facts produced by the engine. Every state-changing function returns a list of these. */
export type EngineEvent =
  | { type: "roll"; kind: "check" | "attack" | "save" | "initiative" | "revive" | "heal"; who: string; whoName: string; label: string; dice: number[]; modifier: number; total: number; target: number; outcome: "success" | "failure" | "crit" | "fumble" }
  | { type: "check_requested"; target: string; ability: string; dc: number; tags: string[]; reason: string }
  | { type: "damage"; target: string; targetName: string; source?: string; sourceName?: string; amount: number; absorbed: number; hp: number; hpMax: number; damageType?: DamageType; dice?: number[]; crit?: boolean; modifier?: string }
  | { type: "heal"; target: string; targetName: string; source?: string; sourceName?: string; amount: number; hp: number; hpMax: number; dice?: number[] }
  | { type: "shield"; target: string; targetName: string; absorb: number; turns: number }
  | { type: "condition_applied"; target: string; targetName: string; condition: Condition; turns: number; source?: string }
  | { type: "condition_ended"; target: string; targetName: string; condition: Condition }
  | { type: "condition_resisted"; target: string; targetName: string; condition: Condition; reason: string }
  | { type: "ability_used"; entityId: string; entityName: string; abilityId: string; abilityName: string; target?: string; targetName?: string }
  | { type: "attack_missed"; attacker: string; attackerName: string; target: string; targetName: string }
  | { type: "moved"; entityId: string; entityName: string; from: { x: number; y: number }; to: { x: number; y: number }; tiles: number; reason: "walk" | "dash" | "teleport" | "push" | "pull" | "place" | "scene" }
  | { type: "downed"; entityId: string; entityName: string }
  | { type: "revived"; entityId: string; entityName: string; hp: number }
  | { type: "out_of_fight"; entityId: string; entityName: string }
  | { type: "defeated"; entityId: string; entityName: string }
  | { type: "woke"; entityId: string; entityName: string; hp: number }
  | { type: "combat_started"; order: { entity_id: string; initiative: number }[]; difficulty: Difficulty; round: number }
  | { type: "turn_started"; entityId: string; entityName: string; round: number }
  | { type: "turn_ended"; entityId: string; entityName: string }
  | { type: "round_started"; round: number }
  | { type: "combat_ended"; reason: "victory" | "flee" | "truce" | "defeat" }
  | { type: "enemies_cleared" }
  | { type: "party_downed" }
  | { type: "terrain_added"; kind: string; x: number; y: number; turns: number | null }
  | { type: "terrain_removed"; kind: string; x: number; y: number; reason: string }
  | { type: "revealed"; entityId: string; found: number }
  | { type: "check_bonus_applied"; target: string; targetName: string; bonus: number; tags: string[]; turns: number }
  | { type: "effect_failed"; entityId: string; abilityName: string; reason: string }
  | { type: "map_added"; mapId: string }
  | { type: "scene_changed"; mapId: string; entry: string }
  | { type: "map_requested"; biome: string }
  | { type: "entity_spawned"; entityId: string; name: string; archetypeId: string; x: number; y: number; mapId: string }
  | { type: "npc_created"; entityId: string; name: string; role: string; x: number; y: number }
  | { type: "npc_said"; entityId: string; name: string; text: string }
  | { type: "npc_died"; entityId: string; name: string }
  | { type: "item_granted"; recipient: string; recipientName: string; itemId: string; name: string; kind: string; value: number; tier?: number; equipped?: boolean }
  | { type: "item_used"; entityId: string; entityName: string; itemName: string }
  | { type: "quest_updated"; questId: string; title: string; status: string; note: string }
  | { type: "fact_set"; subject: string; predicate: string; object: string }
  | { type: "growth_awarded"; characterId: string; name: string; amount: number; reason: string; growth: number }
  | { type: "milestone_completed"; milestoneId: string; description: string }
  | { type: "level_up"; characterId: string; name: string; level: number; hpMax: number; scorePoint: boolean }
  | { type: "rest"; hpRestored: number }
  | { type: "chips"; chips: string[] }
  | { type: "action_rejected"; action: string; reason: string }
  | { type: "note"; text: string };

const names = (e: { targetName?: string }) => e.targetName ?? "target";

/** A short "[engine: ...]" line for the DM prompt. */
export function describeEvent(e: EngineEvent): string {
  const wrap = (s: string) => `[engine: ${s}]`;
  switch (e.type) {
    case "roll": {
      const o = e.outcome === "crit" ? "critical hit" : e.outcome === "fumble" ? "natural 1" : e.outcome;
      return wrap(`${e.whoName} rolled ${e.total} against ${e.kind === "attack" ? "Defense" : "DC"} ${e.target} (${e.label}), ${o}`);
    }
    case "check_requested": return wrap(`check requested: ${e.target} ${e.ability} DC ${e.dc} (${e.reason})`);
    case "damage": {
      const by = e.sourceName ? ` from ${e.sourceName}` : "";
      const abs = e.absorbed > 0 ? `, ${e.absorbed} absorbed by a shield` : "";
      return wrap(`${names(e)} takes ${e.amount}${e.damageType ? ` ${e.damageType}` : ""} damage${by}${abs}${e.crit ? " (critical)" : ""}; HP ${e.hp}/${e.hpMax}`);
    }
    case "heal": return wrap(`${names(e)} heals ${e.amount}${e.sourceName ? ` from ${e.sourceName}` : ""}; HP ${e.hp}/${e.hpMax}`);
    case "shield": return wrap(`${names(e)} gains a shield absorbing ${e.absorb} for ${e.turns} turn(s)`);
    case "condition_applied": return wrap(`${names(e)} is ${e.condition} for ${e.turns} turn(s)`);
    case "condition_ended": return wrap(`${names(e)} is no longer ${e.condition}`);
    case "condition_resisted": return wrap(`${names(e)} is not affected by ${e.condition}: ${e.reason}`);
    case "ability_used": return wrap(`${e.entityName} uses ${e.abilityName}${e.targetName ? ` on ${e.targetName}` : ""}`);
    case "attack_missed": return wrap(`${e.attackerName} attacks ${e.targetName} and misses`);
    case "moved": return wrap(`${e.entityName} ${e.reason === "walk" ? "moves" : e.reason === "place" || e.reason === "scene" ? "is placed" : e.reason} from (${e.from.x},${e.from.y}) to (${e.to.x},${e.to.y})`);
    case "downed": return wrap(`${e.entityName} is downed`);
    case "revived": return wrap(`${e.entityName} is revived with ${e.hp} HP`);
    case "out_of_fight": return wrap(`${e.entityName} is out of the fight`);
    case "defeated": return wrap(`${e.entityName} is defeated`);
    case "woke": return wrap(`${e.entityName} wakes at ${e.hp} HP`);
    case "combat_started": return wrap(`combat begins (${e.difficulty}); initiative order ${e.order.map((o) => `${o.entity_id} ${o.initiative}`).join(", ")}`);
    case "turn_started": return wrap(`round ${e.round}: ${e.entityName}'s turn`);
    case "turn_ended": return wrap(`${e.entityName}'s turn ends`);
    case "round_started": return wrap(`round ${e.round} begins`);
    case "combat_ended": return wrap(`combat ends (${e.reason})`);
    case "enemies_cleared": return wrap("no enemies remain standing");
    case "party_downed": return wrap("every party member is downed; narrate a consequence, not game over");
    case "terrain_added": return wrap(`${e.kind} appears at (${e.x},${e.y})${e.turns ? ` for ${e.turns} turn(s)` : ""}`);
    case "terrain_removed": return wrap(`${e.kind} at (${e.x},${e.y}) is gone (${e.reason})`);
    case "revealed": return wrap(`${e.found} hidden thing(s) revealed`);
    case "check_bonus_applied": return wrap(`${e.targetName} gains +${e.bonus} on ${e.tags.join("/")} checks for ${e.turns} turn(s)`);
    case "effect_failed": return wrap(`${e.abilityName}: part of the effect failed (${e.reason})`);
    case "map_added": return wrap(`map ${e.mapId} is ready`);
    case "scene_changed": return wrap(`the party arrives at ${e.mapId} (${e.entry})`);
    case "map_requested": return wrap(`a ${e.biome} map is being prepared`);
    case "entity_spawned": return wrap(`${e.name} appears at (${e.x},${e.y})`);
    case "npc_created": return wrap(`${e.name} (${e.role}) is here at (${e.x},${e.y})`);
    case "npc_said": return wrap(`${e.name} says: ${e.text}`);
    case "npc_died": return wrap(`${e.name} is dead`);
    case "item_granted": return wrap(`${e.recipientName} receives ${e.name} (${e.kind}, value ${e.value}${e.tier ? `, tier ${e.tier}` : ""}${e.equipped ? ", equipped" : ""})`);
    case "item_used": return wrap(`${e.entityName} uses ${e.itemName}`);
    case "quest_updated": return wrap(`quest "${e.title}" is now ${e.status}${e.note ? `: ${e.note}` : ""}`);
    case "fact_set": return wrap(`fact recorded: ${e.subject} ${e.predicate} ${e.object}`);
    case "growth_awarded": return wrap(`${e.name} gains ${e.amount} growth (${e.reason})`);
    case "milestone_completed": return wrap(`milestone reached: ${e.description}`);
    case "level_up": return wrap(`${e.name} reaches level ${e.level} (max HP ${e.hpMax})${e.scorePoint ? "; +1 ability score available" : ""}`);
    case "rest": return wrap(`the party rests and recovers ${e.hpRestored} HP in total`);
    case "chips": return wrap(`suggested replies: ${e.chips.join(" | ")}`);
    case "action_rejected": return wrap(`${e.action} was refused: ${e.reason}`);
    case "note": return wrap(e.text);
  }
}
