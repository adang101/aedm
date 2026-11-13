/**
 * Deterministic intent pre-router (outside combat). Pure: text and a description of the scene in, a verdict out.
 *
 * It recognizes only unambiguous mechanical commands (full-sentence matches, nothing extra) and treats everything
 * else as narrative, so free text always still reaches the DM. Commands the engine has no API for (opening, picking
 * up, examining, talking) are deliberately narrative.
 */

export type Direction = "n" | "s" | "e" | "w";

export interface IntentContext {
  /** The speaking character's entity id; it is never a valid walk target for itself. */
  actorId?: string;
  /** Interactable objects on the current map. */
  objects: { id: string; kind: string }[];
  /** Exits of the current map, by name. */
  exits: { name: string }[];
  /** Entities on the current map. Enemies are never walk targets. */
  entities: { id: string; name: string; kind: "pc" | "npc" | "enemy" }[];
}

export interface MoveTarget { type: "object" | "exit" | "entity"; id: string }

export type ClassifiedIntent =
  | { kind: "narrative" }
  | { kind: "mechanical"; action: "empty" }
  | { kind: "mechanical"; action: "ooc"; text: string }
  | { kind: "mechanical"; action: "move_dir"; direction: Direction }
  | { kind: "mechanical"; action: "move_to"; target: MoveTarget; label: string };

const NARRATIVE: ClassifiedIntent = { kind: "narrative" };

const DIRECTIONS: Record<string, Direction> = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w" };

const LEAD = "(?:(?:i|we)(?:'ll| will)?\\s+|let's\\s+|lets\\s+)?";
const VERB = "(?:walk|go|head|move|step|run|travel)";
const DIR_RE = new RegExp(`^${LEAD}${VERB}\\s+(?:to the\\s+|toward the\\s+|towards the\\s+|to\\s+)?(north|south|east|west|n|s|e|w)$`);
const TO_RE = new RegExp(`^${LEAD}(?:${VERB}(?:\\s+over)?\\s+(?:up\\s+to|to|toward|towards)|approach)\\s+(.+)$`);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "").trim();
}

const stripArticle = (s: string): string => s.replace(/^(?:the|a|an)\s+/, "");

export function classifyIntent(text: string, ctx: IntentContext): ClassifiedIntent {
  const raw = text.trim();
  if (raw === "") return { kind: "mechanical", action: "empty" };
  const ooc = /^\/ooc(?:\s+([\s\S]*))?$/i.exec(raw);
  if (ooc) return { kind: "mechanical", action: "ooc", text: (ooc[1] ?? "").trim() };

  const t = normalize(raw);
  const dir = DIR_RE.exec(t);
  if (dir) return { kind: "mechanical", action: "move_dir", direction: DIRECTIONS[dir[1] as string] as Direction };

  const to = TO_RE.exec(t);
  if (!to) return NARRATIVE;
  const name = stripArticle(to[1] as string);
  // Anything beyond a bare name (clauses, adverbs, punctuation) will not match a scene name and falls through.
  if (name === "" || /[,;:()?]/.test(name)) return NARRATIVE;

  const hits: { target: MoveTarget; label: string }[] = [];
  for (const o of ctx.objects) if (o.kind.toLowerCase() === name) hits.push({ target: { type: "object", id: o.id }, label: `the ${o.kind}` });
  for (const x of ctx.exits) if (stripArticle(x.name.toLowerCase()) === name) hits.push({ target: { type: "exit", id: x.name }, label: x.name });
  for (const e of ctx.entities) {
    if (e.kind === "enemy" || e.id === ctx.actorId) continue;
    if (stripArticle(e.name.toLowerCase()) === name) hits.push({ target: { type: "entity", id: e.id }, label: e.name });
  }
  // Self and hostile matches still count toward ambiguity: "go to Mara" must not resolve to a second Mara.
  const shadow = ctx.entities.filter((e) => (e.kind === "enemy" || e.id === ctx.actorId) && stripArticle(e.name.toLowerCase()) === name);
  if (hits.length !== 1 || shadow.length > 0) return NARRATIVE;
  const hit = hits[0] as { target: MoveTarget; label: string };
  return { kind: "mechanical", action: "move_to", target: hit.target, label: hit.label };
}
