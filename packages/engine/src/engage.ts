/** Who fights when the engine itself starts a fight (a player attacks a hostile creature). Pure. */
import { DIFFICULTIES, type Difficulty } from "@aedm/schemas";
import { archetypeOf, isStanding } from "./mutate.ts";
import { sideOf, type GameState } from "./state.ts";
import { encounterBudget, enemyThreat } from "./threat.ts";

export type EngagementPlan =
  | { ok: true; participants: string[]; difficulty: Difficulty; foes: string[]; starter: string }
  | { ok: false; reason: string };

/**
 * Plan a fight started by `attackerId` hitting `targetId` outside combat. The participants are the present party characters
 * on the attacker's map, living allied NPCs there, and every living hostile enemy there. The difficulty is the lowest
 * from `standard` up whose budget covers the enemies' threat (or the highest, if none does).
 */
export function planEngagement(
  state: GameState, attackerId: string, targetId: string, ctx: { presentCharacterIds: readonly string[]; partyLevel: number },
): EngagementPlan {
  if (state.combat) return { ok: false, reason: "a combat is already active" };
  const attacker = state.entities[attackerId];
  if (!attacker || attacker.kind !== "pc") return { ok: false, reason: "the attacker is not a party character" };
  if (!isStanding(attacker)) return { ok: false, reason: `${attacker.name} cannot fight` };
  const target = state.entities[targetId];
  if (!target) return { ok: false, reason: "the target is gone" };
  if (target.kind !== "enemy" || sideOf(target) !== "enemy") return { ok: false, reason: `${target.name} is not a hostile enemy` };
  if (!isStanding(target)) return { ok: false, reason: `${target.name} is already down` };
  if (target.mapId !== attacker.mapId) return { ok: false, reason: `${target.name} is on another map` };

  const here = Object.values(state.entities).filter((e) => e.mapId === attacker.mapId && isStanding(e));
  const party = here.filter((e) => e.kind === "pc" && ctx.presentCharacterIds.includes(e.id));
  if (!party.some((e) => e.id === attacker.id)) party.unshift(attacker);
  const allies = here.filter((e) => e.kind === "npc" && state.npcs[e.refId]?.role === "ally");
  const foes = here.filter((e) => e.kind === "enemy" && e.disposition === "hostile");
  if (!foes.some((e) => e.id === target.id)) foes.unshift(target);

  const threat = foes.reduce((sum, e) => {
    const a = archetypeOf(state, e);
    return sum + (a ? a.threat ?? enemyThreat(a) : 0);
  }, 0);
  const boss = foes.some((e) => archetypeOf(state, e)?.role === "boss");
  const size = Math.max(1, party.length);
  const from = Math.max(0, DIFFICULTIES.indexOf("standard"));
  let difficulty: Difficulty = DIFFICULTIES[DIFFICULTIES.length - 1] as Difficulty;
  for (const d of DIFFICULTIES.slice(from)) {
    if (threat <= encounterBudget(size, ctx.partyLevel, d, { boss }) + 1e-9) { difficulty = d; break; }
  }
  return {
    ok: true,
    participants: [...party, ...allies, ...foes].map((e) => e.id),
    difficulty,
    foes: foes.map((e) => e.name),
    starter: attacker.name,
  };
}
