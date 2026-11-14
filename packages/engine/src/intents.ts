/**
 * Deterministic intent pre-router (outside combat). Pure: text and a description of the scene in, a verdict out.
 *
 * It recognizes only unambiguous mechanical commands (full-sentence matches, nothing extra) and treats everything
 * else as narrative, so free text always still reaches the DM: walking, the object verbs (open, close, unlock, pick the
 * lock, force, pull, read, examine an object or a uniquely named creature), taking from an adjacent container, dropping, giving,
 * using a carried item, attacking a uniquely named enemy, looking around, checking the pack and waiting. Extra clauses, adverbs
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
  /** Exits of the current map, by name, and the map edge they are on when known. */
  exits: { name: string; side?: Direction }[];
  /** Entities on the current map. Enemies are never walk targets. */
  entities: { id: string; name: string; kind: "pc" | "npc" | "enemy" }[];
  /**
   * Containers the table can see on the current map (never NPC pockets). `items` is given only for what is open to
   * look into (an opened chest, a pile, remains); `objectId` links a chest to its map object.
   */
  containers?: { id: string; kind: "chest" | "pile" | "remains"; label: string; dist?: number; objectId?: string; items?: { id: string; name: string }[] }[];
  /** What the actor carries. `usable: false` marks an item the engine cannot use by name; absent means unknown (treated as usable). */
  inventory?: { id: string; name: string; usable?: boolean }[];
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
  | { kind: "mechanical"; action: "give"; itemId: string; toId: string; label: string }
  | { kind: "mechanical"; action: "look" }
  | { kind: "mechanical"; action: "inventory" }
  | { kind: "mechanical"; action: "wait" }
  | { kind: "mechanical"; action: "use_item"; itemId: string; targetId?: string; label: string }
  | { kind: "mechanical"; action: "attack"; targetId: string; label: string };

const NARRATIVE: ClassifiedIntent = { kind: "narrative" };

const DIRECTIONS: Record<string, Direction> = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w" };

const LEAD = "(?:(?:i|we)(?:'ll| will)?\\s+|let's\\s+|lets\\s+)?";
const VERB = "(?:walk|go|head|move|step|run|travel)";
const DIR_RE = new RegExp(`^${LEAD}${VERB}\\s+(?:to the\\s+|toward the\\s+|towards the\\s+|to\\s+)?(north|south|east|west|n|s|e|w)$`);
const TO_RE = new RegExp(`^${LEAD}(?:${VERB}(?:\\s+over)?\\s+(?:up\\s+to|to|toward|towards)|approach)\\s+(.+)$`);
/** Places only (an object or an exit, never a creature): "go through the door", "enter the cellar stairs", "leave through the north gate". */
const THROUGH_RE = new RegExp(`^${LEAD}(?:${VERB}\\s+(?:through|into)|enter|(?:leave|exit)\\s+(?:through|via))\\s+(.+)$`);
const EXIT_SIDE_RE = new RegExp(`^${LEAD}(?:take|use)\\s+the\\s+(?:(north|south|east|west)\\s+)?(?:exit|way out)$`);

const LOOK_RE = new RegExp(
  `^${LEAD}(?:look(?:\\s+around(?:\\s+(?:the\\s+)?(?:room|area|here))?)?|(?:take|have)\\s+a\\s+look\\s+around|survey\\s+the\\s+(?:room|area|place|surroundings|scene)|what(?:'s|\\s+is)\\s+around(?:\\s+me)?\\??|what\\s+(?:do\\s+)?(?:i|we)\\s+see\\??)$`,
);
const INVENTORY_RE = new RegExp(
  `^${LEAD}(?:inventory|(?:check|open|view|show|list)\\s+(?:my\\s+)?(?:inventory|pack|bag|backpack|items|gear)|what\\s+(?:am\\s+i|are\\s+we)\\s+(?:carrying|holding)\\??|what\\s+do\\s+i\\s+(?:have|carry)\\??|what(?:'s|\\s+is)\\s+in\\s+my\\s+(?:pack|bag|backpack|inventory)\\??)$`,
);
const WAIT_RE = new RegExp(`^${LEAD}(?:wait(?:\\s+here)?|do\\s+nothing|pass(?:\\s+(?:my\\s+)?turn)?)$`);
const USE_RE = new RegExp(`^${LEAD}(?:drink|quaff|use)\\s+(.+?)(?:\\s+on\\s+(.+))?$`);
const ATTACK_RE = new RegExp(`^${LEAD}(?:attack|fight|strike|hit|shoot|charge)(?:\\s+at)?\\s+(.+)$`);

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

/** The one party member a name means: an exact full name, else a unique first name. */
function partyMember(who: string, ctx: IntentContext): IntentContext["entities"][number] | undefined {
  const pcs = ctx.entities.filter((e) => e.kind === "pc");
  const exact = pcs.filter((e) => e.name.toLowerCase() === who);
  const firsts = pcs.filter((e) => e.name.toLowerCase().split(" ")[0] === who);
  const pick = exact.length > 0 ? exact : firsts;
  return pick.length === 1 ? pick[0] : undefined;
}

function classifyInteraction(t: string, ctx: IntentContext): ClassifiedIntent | undefined {
  for (const v of OBJECT_VERBS) {
    const m = v.re.exec(t);
    if (!m) continue;
    const name = bare(m[1] as string);
    if (!clean(name)) return NARRATIVE;
    const hit = resolveTarget(name, v.kinds, ctx, v.reach);
    if (v.verb === "examine") {
      // a creature may be examined too, when its name is unique and nothing else in the scene answers to it
      const objectHits = targetsOf(ctx).filter((x) => v.kinds.includes(x.kind) && x.names.includes(name));
      const creatures = ctx.entities.filter((e) => stripArticle(e.name.toLowerCase()) === name);
      const only = creatures[0];
      if (!hit && objectHits.length === 0 && creatures.length === 1 && only && only.id !== ctx.actorId) {
        return { kind: "mechanical", action: "act", verb: "examine", targetId: only.id, label: only.name };
      }
      if (creatures.length > 0) return NARRATIVE;
    }
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
  const use = USE_RE.exec(t);
  if (use) {
    const first = bare(use[1] as string);
    const who = use[2] === undefined ? undefined : bare(use[2]);
    // an item whose own name contains " on " is tried whole, with no target
    let item = clean(first) ? carried(first)[0] : undefined;
    let target = who;
    if (!item && who !== undefined && clean(first) && clean(who)) { item = carried(`${first} on ${who}`)[0]; target = undefined; }
    if (!item || item.usable === false) return NARRATIVE;
    if (target === undefined) return { kind: "mechanical", action: "use_item", itemId: item.id, label: item.name };
    const to = clean(target) ? partyMember(target, ctx) : undefined;
    if (!to) return NARRATIVE;
    if (to.id === ctx.actorId) return { kind: "mechanical", action: "use_item", itemId: item.id, label: item.name };
    return { kind: "mechanical", action: "use_item", itemId: item.id, targetId: to.id, label: `${item.name} on ${to.name}` };
  }
  const attack = ATTACK_RE.exec(t);
  if (attack) {
    const name = bare(attack[1] as string);
    const hits = clean(name) ? ctx.entities.filter((e) => stripArticle(e.name.toLowerCase()) === name) : [];
    const only = hits[0];
    // an NPC, a party member or the speaker with the same name makes it narrative: only a lone enemy is a mechanical target
    if (hits.length !== 1 || !only || only.kind !== "enemy") return NARRATIVE;
    return { kind: "mechanical", action: "attack", targetId: only.id, label: only.name };
  }

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
    const to = partyMember(who, ctx);
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
  if (LOOK_RE.test(t)) return { kind: "mechanical", action: "look" };
  if (INVENTORY_RE.test(t)) return { kind: "mechanical", action: "inventory" };
  if (WAIT_RE.test(t)) return { kind: "mechanical", action: "wait" };
  const dir = DIR_RE.exec(t);
  if (dir) return { kind: "mechanical", action: "move_dir", direction: DIRECTIONS[dir[1] as string] as Direction };

  const side = EXIT_SIDE_RE.exec(t);
  if (side) {
    const want = side[1] === undefined ? undefined : (DIRECTIONS[side[1]] as Direction);
    const exits = ctx.exits.filter((x) => want === undefined || x.side === want);
    const only = exits[0];
    // "take the exit" needs the map to have exactly one; "take the north exit" exactly one on that side
    if (!only || exits.length !== 1 || (want === undefined && ctx.exits.length !== 1)) return NARRATIVE;
    return { kind: "mechanical", action: "move_to", target: { type: "exit", id: only.name }, label: only.name };
  }

  const interaction = classifyInteraction(t, ctx);
  if (interaction) return interaction;

  const to = TO_RE.exec(t);
  const through = to ? null : THROUGH_RE.exec(t);
  const m = to ?? through;
  if (!m) return NARRATIVE;
  const name = stripArticle(m[1] as string);
  // Anything beyond a bare name (clauses, adverbs, punctuation) will not match a scene name and falls through.
  if (name === "" || /[,;:()?]/.test(name)) return NARRATIVE;

  const hits: { target: MoveTarget; label: string }[] = [];
  for (const o of ctx.objects) if (o.kind.toLowerCase() === name) hits.push({ target: { type: "object", id: o.id }, label: `the ${o.kind}` });
  for (const x of ctx.exits) if (stripArticle(x.name.toLowerCase()) === name) hits.push({ target: { type: "exit", id: x.name }, label: x.name });
  for (const e of ctx.entities) {
    if (through || e.kind === "enemy" || e.id === ctx.actorId) continue; // "go through" and "enter" name places, never creatures
    if (stripArticle(e.name.toLowerCase()) === name) hits.push({ target: { type: "entity", id: e.id }, label: e.name });
  }
  // Self and hostile matches still count toward ambiguity: "go to Mara" must not resolve to a second Mara.
  const shadow = ctx.entities.filter((e) => (through || e.kind === "enemy" || e.id === ctx.actorId) && stripArticle(e.name.toLowerCase()) === name);
  if (hits.length !== 1 || shadow.length > 0) return NARRATIVE;
  const hit = hits[0] as { target: MoveTarget; label: string };
  return { kind: "mechanical", action: "move_to", target: hit.target, label: hit.label };
}
