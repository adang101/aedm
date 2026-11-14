/**
 * Deterministic intent pre-router (outside combat). Pure: text and a description of the scene in, a verdict out.
 *
 * It recognizes only unambiguous mechanical commands (full-sentence matches, nothing extra) and treats everything
 * else as narrative, so free text always still reaches the DM: walking, the object verbs (open, close, unlock, pick the
 * lock, force, pull, read, examine), taking from an adjacent container, dropping and giving. Extra clauses, adverbs
 * ("carefully", "while ..."), unknown names and ambiguity (two matching targets) all mean narrative.
 */
import type { ActVerb } from "@aedm/schemas";
import { INTERACT } from "./data.ts";

export type Direction = "n" | "s" | "e" | "w";

export interface IntentContext {
  /** The speaking character's entity id; it is never a valid walk target for itself. */
  actorId?: string;
  /** Interactable objects on the current map. */
  objects: { id: string; kind: string; /** Chebyshev distance from the actor, in tiles. */ dist?: number }[];
  /** Exits of the current map, by name. */
  exits: { name: string }[];
  /** Entities on the current map. Enemies are never walk targets. */
  entities: { id: string; name: string; kind: "pc" | "npc" | "enemy" }[];
  /**
   * Containers the table can see on the current map (never NPC pockets). `items` is given only for what is open to
   * look into (an opened chest, a pile, remains); `objectId` links a chest to its map object.
   */
  containers?: { id: string; kind: "chest" | "pile" | "remains"; label: string; dist?: number; objectId?: string; items?: { id: string; name: string }[] }[];
  /** What the actor carries. */
  inventory?: { id: string; name: string }[];
}

export interface MoveTarget { type: "object" | "exit" | "entity"; id: string }

export type ClassifiedIntent =
  | { kind: "narrative" }
  | { kind: "mechanical"; action: "empty" }
  | { kind: "mechanical"; action: "ooc"; text: string }
  | { kind: "mechanical"; action: "move_dir"; direction: Direction }
  | { kind: "mechanical"; action: "move_to"; target: MoveTarget; label: string }
  | { kind: "mechanical"; action: "act"; verb: ActVerb; targetId: string; label: string }
  | { kind: "mechanical"; action: "take"; containerId: string; itemId: string; label: string }
  | { kind: "mechanical"; action: "take_all"; containerId: string; label: string }
  | { kind: "mechanical"; action: "drop"; itemId: string; label: string }
  | { kind: "mechanical"; action: "give"; itemId: string; toId: string; label: string };

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

interface Target { id: string; kind: string; names: string[]; dist: number; container?: NonNullable<IntentContext["containers"]>[number] }

/** Everything a typed command can name in the scene: map objects, and containers (a chest is listed once, as its map object). */
function targetsOf(ctx: IntentContext): Target[] {
  const out: Target[] = ctx.objects.map((o) => ({ id: o.id, kind: o.kind, names: [o.kind.toLowerCase(), o.id.toLowerCase()], dist: o.dist ?? Infinity }));
  const objectIds = new Set(ctx.objects.map((o) => o.id));
  for (const cn of ctx.containers ?? []) {
    const label = cn.label.toLowerCase();
    const t: Target = { id: cn.id, kind: cn.kind, names: [cn.kind, label, cn.id.toLowerCase()], dist: cn.dist ?? Infinity, container: cn };
    const twin = cn.objectId !== undefined && objectIds.has(cn.objectId) ? out.find((o) => o.id === cn.objectId) : undefined;
    if (twin) { twin.container = cn; if (cn.dist !== undefined) twin.dist = Math.min(twin.dist, cn.dist); continue; }
    out.push(t);
  }
  return out;
}

/** The one target a name means, among those of the allowed kinds; with several, the only one within reach; else none. */
function resolveTarget(name: string, kinds: readonly string[], ctx: IntentContext, reach: number): Target | undefined {
  const hits = targetsOf(ctx).filter((t) => kinds.includes(t.kind) && t.names.includes(name));
  if (hits.length === 1) return hits[0];
  const near = hits.filter((t) => t.dist <= reach);
  return hits.length > 1 && near.length === 1 ? near[0] : undefined;
}

const OPENABLE = ["door", "chest", "pile", "remains"];
const LOCKED = ["door", "chest"];
const LOOKABLE = ["door", "chest", "lever", "sign", "altar", "pile", "remains"];
const bare = (s: string): string => stripArticle(s.replace(/^(?:my|the|a|an)\s+/, "")).trim();
const clean = (s: string): boolean => s !== "" && !/[,;:()?]/.test(s);

const OBJECT_VERBS: { re: RegExp; verb: ActVerb; kinds: readonly string[]; reach: number }[] = [
  { re: new RegExp(`^${LEAD}open\\s+(.+)$`), verb: "open", kinds: OPENABLE, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}close\\s+(.+)$`), verb: "close", kinds: OPENABLE, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}unlock\\s+(.+)$`), verb: "unlock", kinds: LOCKED, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}pick\\s+(?:the\\s+|a\\s+)?lock\\s+(?:on|of)\\s+(.+)$`), verb: "pick_lock", kinds: LOCKED, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}(?:force|break)\\s+open\\s+(.+)$`), verb: "force", kinds: LOCKED, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}(?:force|break)\\s+(.+?)\\s+open$`), verb: "force", kinds: LOCKED, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}(?:force|break)\\s+(.+)$`), verb: "force", kinds: LOCKED, reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}pull\\s+(.+)$`), verb: "pull", kinds: ["lever"], reach: INTERACT.reach },
  { re: new RegExp(`^${LEAD}read\\s+(.+)$`), verb: "read", kinds: ["sign"], reach: INTERACT.examineReach },
  { re: new RegExp(`^${LEAD}(?:examine|inspect|look at)\\s+(.+)$`), verb: "examine", kinds: LOOKABLE, reach: INTERACT.examineReach },
];

const TAKE_ALL_RE = new RegExp(`^${LEAD}(?:take|grab|get|loot)\\s+(?:everything|all|it all|all of it)(?:\\s+(?:from|in|out of)\\s+(.+))?$`);
const LOOT_RE = new RegExp(`^${LEAD}loot\\s+(.+)$`);
const TAKE_RE = new RegExp(`^${LEAD}(?:take|grab|get|pick up)\\s+(.+?)(?:\\s+(?:from|out of|in)\\s+(.+))?$`);
const DROP_RE = new RegExp(`^${LEAD}drop\\s+(.+)$`);
const GIVE_RE = new RegExp(`^${LEAD}give\\s+(.+?)\\s+to\\s+(.+)$`);

function classifyInteraction(t: string, ctx: IntentContext): ClassifiedIntent | undefined {
  for (const v of OBJECT_VERBS) {
    const m = v.re.exec(t);
    if (!m) continue;
    const name = bare(m[1] as string);
    if (!clean(name)) return NARRATIVE;
    const hit = resolveTarget(name, v.kinds, ctx, v.reach);
    if (!hit) return NARRATIVE;
    return { kind: "mechanical", action: "act", verb: v.verb, targetId: hit.id, label: `the ${hit.kind}` };
  }

  // containers the actor can reach, and their contents where they can be seen
  const reachable = targetsOf(ctx).filter((x) => x.container && x.dist <= INTERACT.reach);
  const named = (name: string): Target | undefined => resolveTarget(name, ["chest", "pile", "remains"], ctx, INTERACT.reach);
  const loot = (hit: Target | undefined): ClassifiedIntent => {
    const cn = hit?.container;
    if (!hit || !cn || hit.dist > INTERACT.reach) return NARRATIVE;
    return { kind: "mechanical", action: "take_all", containerId: cn.id, label: `everything from ${hit.names[0] === hit.kind ? `the ${hit.kind}` : cn.label}` };
  };

  const all = TAKE_ALL_RE.exec(t);
  if (all) {
    if (all[1] === undefined) return reachable.length === 1 ? loot(reachable[0]) : NARRATIVE;
    const name = bare(all[1]);
    return clean(name) ? loot(named(name)) : NARRATIVE;
  }
  const lootM = LOOT_RE.exec(t);
  if (lootM) {
    const name = bare(lootM[1] as string);
    return clean(name) ? loot(named(name)) : NARRATIVE;
  }
  const take = TAKE_RE.exec(t);
  if (take) {
    const item = bare(take[1] as string);
    if (!clean(item) || (take[2] !== undefined && !clean(bare(take[2])))) return NARRATIVE;
    let pool = reachable;
    if (take[2] !== undefined) {
      const from = named(bare(take[2]));
      pool = from && from.dist <= INTERACT.reach ? [from] : [];
    }
    const hits = pool.flatMap((x) => (x.container?.items ?? []).filter((i) => i.name.toLowerCase() === item).map((i) => ({ cn: x.container!, item: i })));
    const first = hits[0];
    if (!first || hits.some((h) => h.cn.id !== first.cn.id)) return NARRATIVE;
    return { kind: "mechanical", action: "take", containerId: first.cn.id, itemId: first.item.id, label: first.item.name };
  }

  const carried = (name: string) => (ctx.inventory ?? []).filter((i) => i.name.toLowerCase() === name);
  const drop = DROP_RE.exec(t);
  if (drop) {
    const name = bare(drop[1] as string);
    const hit = clean(name) ? carried(name)[0] : undefined;
    return hit ? { kind: "mechanical", action: "drop", itemId: hit.id, label: hit.name } : NARRATIVE;
  }
  const give = GIVE_RE.exec(t);
  if (give) {
    const name = bare(give[1] as string);
    const who = bare(give[2] as string);
    const item = clean(name) && clean(who) ? carried(name)[0] : undefined;
    if (!item) return NARRATIVE;
    const pcs = ctx.entities.filter((e) => e.kind === "pc");
    const exact = pcs.filter((e) => e.name.toLowerCase() === who);
    const firsts = pcs.filter((e) => e.name.toLowerCase().split(" ")[0] === who);
    const pick = exact.length > 0 ? exact : firsts;
    const to = pick.length === 1 ? pick[0] : undefined;
    if (!to || to.id === ctx.actorId) return NARRATIVE;
    return { kind: "mechanical", action: "give", itemId: item.id, toId: to.id, label: `${item.name} to ${to.name}` };
  }
  return undefined;
}

export function classifyIntent(text: string, ctx: IntentContext): ClassifiedIntent {
  const raw = text.trim();
  if (raw === "") return { kind: "mechanical", action: "empty" };
  const ooc = /^\/ooc(?:\s+([\s\S]*))?$/i.exec(raw);
  if (ooc) return { kind: "mechanical", action: "ooc", text: (ooc[1] ?? "").trim() };

  const t = normalize(raw);
  const dir = DIR_RE.exec(t);
  if (dir) return { kind: "mechanical", action: "move_dir", direction: DIRECTIONS[dir[1] as string] as Direction };

  const interaction = classifyInteraction(t, ctx);
  if (interaction) return interaction;

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
