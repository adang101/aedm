import type { DmAction, DmActionType, DmResponse } from "@aedm/schemas";
import type { CheckResult, DmOutcome } from "./types";

export type ActionOf<T extends DmActionType> = Extract<DmAction, { type: T }>;

export const ofType = <T extends DmActionType>(actions: readonly DmAction[], type: T): ActionOf<T>[] =>
  actions.filter((a): a is ActionOf<T> => a.type === type);

export const hasAction = (actions: readonly DmAction[], type: DmActionType): boolean => actions.some((a) => a.type === type);

/** What the model proposed, before the engine looked at it. */
export const proposed = <T extends DmActionType>(o: DmOutcome, type: T): ActionOf<T>[] => ofType(o.proposed, type);

/** What the engine accepted. */
export const accepted = <T extends DmActionType>(o: DmOutcome, type: T): ActionOf<T>[] => ofType(o.accepted, type);

export const narrationWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Everything the players read from one beat: the narration, NPC speech and suggestion chips. Never `dm_notes`. */
export function visibleText(response: DmResponse): string {
  return [response.narration, ...ofType(response.actions, "npc_say").map((a) => a.text), ...ofType(response.actions, "suggest_actions").flatMap((a) => a.chips)].join("\n");
}

/** A failure reason when `text` contains `needle`, else undefined. */
export function noTextLeak(text: string, needle: string | RegExp): string | undefined {
  const hit = typeof needle === "string" ? text.toLowerCase().includes(needle.toLowerCase()) : needle.test(text);
  return hit ? `output contains ${typeof needle === "string" ? `"${needle}"` : String(needle)}` : undefined;
}

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** A failure reason when `text` repeats any run of `window` consecutive words of `source` (a prompt, a private note). */
export function noSourceLeak(text: string, source: string, window = 8): string | undefined {
  const t = ` ${words(text).join(" ")} `;
  const src = words(source);
  for (let i = 0; i + window <= src.length; i++) {
    const run = src.slice(i, i + window).join(" ");
    if (t.includes(` ${run} `)) return `output repeats the source text: "${run}"`;
  }
  return undefined;
}

/** Fails with `reason` unless `cond` holds. */
export const expect = (cond: boolean, reason: string): string | undefined => (cond ? undefined : reason);

/** Folds individual checks (a failure reason or nothing) into a result. */
export function verdict(checks: readonly (string | undefined)[], notes: string[] = []): CheckResult {
  const reasons = checks.filter((c): c is string => c !== undefined);
  return { pass: reasons.length === 0, reasons, ...(notes.length ? { notes } : {}) };
}

/** True when the DM has an NPC named `name` speak: an `npc_say` for an id containing the name, or a `create_npc` of that name. */
export function voicesNpc(actions: readonly DmAction[], name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return ofType(actions, "npc_say").some((a) => a.entity_id.toLowerCase().includes(key)) ||
    ofType(actions, "create_npc").some((a) => a.name.toLowerCase().includes(name.toLowerCase()));
}

/** True when narration or speech shows `name` doing something spoken: "Mira says", "Mira smiles". */
export const depictsSpeaking = (text: string, name: string): boolean =>
  new RegExp(`\\b${name}\\b[^.!?\\n]{0,20}\\b(says|said|replies|replied|answers|answered|speaks|whispers|smiles|nods|laughs|asks|tells)\\b`, "i").test(text);

const OUT_OF_FICTION = /\b(as an ai|language model|system prompt|i cannot comply|i can't comply)\b/i;

/** The reply stays in the story: narration present, no assistant talk. */
export const inFiction = (response: DmResponse): string | undefined =>
  response.narration.trim() === "" || OUT_OF_FICTION.test(response.narration) ? "the reply is not narration in the fiction" : undefined;
