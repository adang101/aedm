/**
 * Deterministic combat narrator. Pure: events and a seeded rng in, prose out. No I/O, no clock.
 * Phrasings live in `data/narration.json`; this module only picks and fills them. Numbers in the output
 * always come from the events, never from the templates.
 */
import type { EnemyRole } from "@aedm/schemas";
import { NARRATION } from "./data.ts";
import type { EngineEvent } from "./events.ts";
import type { Rng } from "./rng.ts";

interface Sentence { text: string; kind: string }

/** Fill `{name}` slots. Unknown slots are left empty so a bad template never leaks braces. */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/** Picks a template per kind, avoiding a repeat inside one narration while unused phrasings remain. */
function picker(rng: Rng): (kind: string, vars: Record<string, string | number>) => string {
  const used = new Map<string, Set<number>>();
  return (kind, vars) => {
    const list = NARRATION.templates[kind] ?? [];
    if (list.length === 0) return "";
    let seen = used.get(kind);
    if (!seen || seen.size >= list.length) { seen = new Set(); used.set(kind, seen); }
    const open = list.map((_, i) => i).filter((i) => !seen.has(i));
    const idx = open[rng.int(0, open.length - 1)] as number;
    seen.add(idx);
    return fill(list[idx] as string, vars);
  };
}

/** Prose for a list of combat events. Returns "" when nothing in the list is worth narrating. */
export function narrateEvents(events: readonly EngineEvent[], rng: Rng): string {
  const say = picker(rng);
  const out: Sentence[] = [];
  const push = (kind: string, vars: Record<string, string | number>, tag = kind): void => {
    const text = say(kind, vars);
    if (text) out.push({ text, kind: tag });
  };
  for (const e of events) {
    switch (e.type) {
      case "damage":
        if (e.amount > 0) {
          if (e.sourceName) push(e.crit ? "crit" : "hit", { attacker: e.sourceName, target: e.targetName, amount: e.amount }, "hit");
          else push("hit_unsourced", { target: e.targetName, amount: e.amount }, "hit");
        } else if (e.absorbed > 0) push("absorbed", { target: e.targetName });
        break;
      case "attack_missed": push("miss", { attacker: e.attackerName, target: e.targetName }); break;
      case "ability_used":
        if (e.targetName) push("ability", { actor: e.entityName, ability: e.abilityName, target: e.targetName });
        else push("ability_self", { actor: e.entityName, ability: e.abilityName });
        break;
      case "downed": push("down", { name: e.entityName }); break;
      case "defeated": push("defeated", { name: e.entityName }); break;
      case "out_of_fight": push("out", { name: e.entityName }); break;
      case "revived": push("revived", { name: e.entityName, hp: e.hp }); break;
      case "woke": push("woke", { name: e.entityName, hp: e.hp }); break;
      case "heal":
        if (e.amount > 0) {
          if (e.sourceName && e.sourceName !== e.targetName) push("heal_sourced", { source: e.sourceName, target: e.targetName, amount: e.amount }, "heal");
          else push("heal", { target: e.targetName, amount: e.amount });
        }
        break;
      case "shield": push("shield", { target: e.targetName }); break;
      case "condition_applied": push("condition_applied", { target: e.targetName, condition: NARRATION.conditions[e.condition] ?? e.condition }); break;
      case "condition_ended": push("condition_ended", { target: e.targetName, condition: NARRATION.conditions[e.condition] ?? e.condition }); break;
      case "condition_resisted": push("condition_resisted", { target: e.targetName }); break;
      case "combat_ended":
        if (e.reason === "flee") push("flee", {});
        else if (e.reason === "truce") push("truce", {});
        break;
      default: break;
    }
  }
  // Over the cap: drop misses first (latest first), then cut the tail.
  const max = NARRATION.maxSentences;
  for (let i = out.length - 1; i >= 0 && out.length > max; i--) if (out[i]?.kind === "miss") out.splice(i, 1);
  return out.slice(0, max).map((s) => s.text).join(" ");
}

interface Tally { hits: number; damage: number; misses: number }

const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;

/** One compact engine line summarising a stretch of combat events (used when a round's lines get long). */
export function digestEvents(events: readonly EngineEvent[], round: number): string {
  const byActor = new Map<string, Tally>();
  const tally = (name: string): Tally => {
    let t = byActor.get(name);
    if (!t) { t = { hits: 0, damage: 0, misses: 0 }; byActor.set(name, t); }
    return t;
  };
  const tail: string[] = [];
  for (const e of events) {
    if (e.type === "damage") {
      if (e.amount > 0) { const t = tally(e.sourceName ?? "the surroundings"); t.hits++; t.damage += e.amount; }
    } else if (e.type === "attack_missed") tally(e.attackerName).misses++;
    else if (e.type === "downed") tail.push(`${e.entityName} was downed`);
    else if (e.type === "defeated") tail.push(`${e.entityName} was defeated`);
    else if (e.type === "revived") tail.push(`${e.entityName} was revived`);
    else if (e.type === "out_of_fight") tail.push(`${e.entityName} is out of the fight`);
    else if (e.type === "condition_applied") tail.push(`${e.targetName} became ${e.condition}`);
    else if (e.type === "heal" && e.amount > 0) tail.push(`${e.targetName} healed ${e.amount}`);
  }
  const parts: string[] = [];
  for (const [name, t] of byActor) {
    if (t.hits > 0) parts.push(`${name} hit ${times(t.hits)} for ${t.damage} damage`);
    if (t.misses > 0) parts.push(`${name} missed ${times(t.misses)}`);
  }
  parts.push(...tail);
  if (parts.length === 0) return "";
  return `[engine: round ${round} digest: ${parts.join("; ")}]`;
}

/** What the predicate needs to know about entities. Entities may already be gone from state, so the host resolves them. */
export interface DramaLookup {
  /** Enemy role for an entity id, or undefined for anything that is not a known enemy. */
  role(entityId: string): EnemyRole | undefined;
  isPc(entityId: string): boolean;
}

/** Beats worth a real DM call: a boss or elite falling, or a PC dropping to 0 HP. */
export function isDramaticEvent(e: EngineEvent, lookup: DramaLookup): boolean {
  if (e.type === "defeated") {
    const role = lookup.role(e.entityId);
    return role === "boss" || role === "elite";
  }
  if (e.type === "downed") return lookup.isPc(e.entityId);
  return false;
}

export function hasDramaticBeat(events: readonly EngineEvent[], lookup: DramaLookup): boolean {
  return events.some((e) => isDramaticEvent(e, lookup));
}
