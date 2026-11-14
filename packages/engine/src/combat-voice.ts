/**
 * Engine-written combat prose: the opening of a fight, the close of an ordinary victory and the short
 * "barks" creatures give when their nerve breaks. Pure: facts and a seeded rng in, text out. Phrasings and
 * thresholds live in `data/combat-voice.json`. Numbers in the output come only from the input facts.
 */
import type { EnemyRole } from "@aedm/schemas";
import { COMBAT_VOICE } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import { fill, picker } from "./narrate.ts";
import { archetypeOf, enemyTactics } from "./mutate.ts";
import type { Rng } from "./rng.ts";
import type { Entity, GameState } from "./state.ts";

// ---------- facts ----------

export interface CombatStartInfo {
  /** Display names of every hostile creature in the fight (spawn letters are grouped). */
  foes: readonly string[];
  /** Name of the character who began the fight, if one did. */
  starter?: string;
  /** Who has the first turn. */
  first?: { name: string; side: "party" | "enemy" };
}

export interface CombatEndInfo {
  fell: number;
  fled: number;
  surrendered: number;
  /** Party members still down when the fight ended. */
  partyDown: readonly string[];
}

export interface FightSummary extends CombatEndInfo {
  /** A boss or elite took part (it fell, fled or yielded, or is simply in the fight). */
  leaderInvolved: boolean;
}

/** What the host knows about a creature that is about to react. */
export interface CreatureVoice {
  name: string;
  role: EnemyRole;
  /** Sprite body plan (`humanoid`, `beast`, ...). */
  body: string;
  fearless: boolean;
  cowardly: boolean;
}

export type BarkEvent = Extract<EngineEvent, { type: "morale_broken" | "surrendered" | "fled" | "bloodied" }>;
export type Bark = { kind: "say"; text: string } | { kind: "emote"; text: string };

// ---------- victory ----------

export const isDmVictoryRole = (role: EnemyRole | undefined): boolean => role !== undefined && COMBAT_VOICE.victory.dmRoles.includes(role);

/** True when a won fight still deserves the real DM: a boss or elite was in it, or a party member is still down. */
export function victoryNeedsDm(summary: Pick<FightSummary, "leaderInvolved" | "partyDown">): boolean {
  return summary.leaderInvolved || (COMBAT_VOICE.victory.dmWhenPartyDown && summary.partyDown.length > 0);
}

// ---------- combat start and end ----------

const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${COMBAT_VOICE.listJoin} ${items[items.length - 1]}`;

/** "Marsh Brute A", "Marsh Brute B", "Wolf" becomes "Marsh Brute (x2) and Wolf". */
export function groupFoes(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) {
    const base = n.replace(/\s[A-Z]$/, "").trim() || n;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return list([...counts].map(([name, n]) => (n > 1 ? `${name} (x${n})` : name)));
}

/** One or two sentences opening a fight. Empty when there are no foes to name. */
export function narrateCombatStart(info: CombatStartInfo, rng: Rng): string {
  if (info.foes.length === 0) return "";
  const say = picker(rng, COMBAT_VOICE.templates);
  const foes = groupFoes(info.foes);
  const out: string[] = [];
  out.push(info.starter ? say("start_opening_starter", { starter: info.starter, foes }) : say("start_opening", { foes }));
  if (info.first) out.push(say(info.first.side === "party" ? "start_first_party" : "start_first_enemy", { first: info.first.name }));
  return out.filter(Boolean).join(" ");
}

/** A short close for an ordinary victory. Defeat is never engine-narrated; callers send it to the DM. */
export function narrateCombatEnd(info: CombatEndInfo, rng: Rng): string {
  const say = picker(rng, COMBAT_VOICE.templates);
  const out: string[] = [];
  if (info.fled === 0 && info.surrendered === 0) out.push(say("end_cleared", {}));
  if (info.fled > 0) out.push(say(info.fled === 1 ? "end_fled_one" : "end_fled_many", { count: info.fled }));
  if (info.surrendered > 0) out.push(say(info.surrendered === 1 ? "end_yield_one" : "end_yield_many", { count: info.surrendered }));
  if (info.partyDown.length > 0) out.push(say("end_downed", { names: list(info.partyDown) }));
  return out.filter(Boolean).join(" ");
}

// ---------- barks ----------

/** Facts about an enemy for `barkFor`, or null for anything that is not an enemy creature. */
export function creatureVoice(state: GameState, e: Entity): CreatureVoice | null {
  const a = archetypeOf(state, e);
  if (!a) return null;
  const tactics = enemyTactics(state, e);
  const body = e.sprite.kind === "spec" ? e.sprite.body : e.sprite.kind === "pixel" ? e.sprite.base?.body : undefined;
  return { name: e.name, role: a.role, body: body ?? COMBAT_VOICE.defaultBody, fearless: tactics.has("fearless"), cowardly: tactics.has("cowardly") };
}

function flavorOf(event: BarkEvent, info: CreatureVoice): string {
  switch (event.type) {
    case "morale_broken": return event.reason === "leader_down" ? "leader_down" : info.cowardly ? "cowardly" : "default";
    case "bloodied": return info.fearless ? "fearless" : COMBAT_VOICE.leaderRoles.includes(info.role) ? "leader" : "default";
    default: return info.cowardly ? "cowardly" : "default";
  }
}

/**
 * A short reaction for a breaking, yielding, fleeing or bloodied creature: spoken words for body plans that talk,
 * a described reaction (with the creature's name) for the rest, or null when nothing fits or the dice say stay quiet.
 */
export function barkFor(event: BarkEvent, info: CreatureVoice, rng: Rng): Bark | null {
  const chance = COMBAT_VOICE.barkChancePct[event.type] ?? 0;
  if (chance < 100 && rng.int(1, 100) > chance) return null;
  const talks = COMBAT_VOICE.talkingBodies.includes(info.body);
  const flavor = flavorOf(event, info);
  const group = talks ? undefined : COMBAT_VOICE.emote[COMBAT_VOICE.emoteGroups[info.body] ?? ""];
  const byFlavor = talks ? COMBAT_VOICE.say[event.type] : group?.[event.type];
  const lines = byFlavor?.[flavor]?.length ? byFlavor[flavor] : byFlavor?.["default"];
  if (!lines || lines.length === 0) return null;
  const text = fill(lines[rng.int(0, lines.length - 1)] as string, { name: info.name });
  return { kind: talks ? "say" : "emote", text };
}
