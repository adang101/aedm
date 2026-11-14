import interact from "@aedm/engine/data/interact.json";
import type { ActVerb, CharacterView, ContainerSummary, EntityView, GameMap, Item } from "@aedm/schemas";

/** Numbers come from the engine's data files, never hardcoded here. */
export const REACH: number = interact.reach;
export const EXAMINE_REACH: number = interact.examineReach;
const NO_TRANSFER: readonly string[] = interact.noTransferKinds;

export interface Pt { x: number; y: number }

export function cheb(a: Pt, b: Pt): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** What the menu needs to know about something on the map. */
export type Target =
  | { type: "interactable"; id: string; kind: string; state: string; x: number; y: number; lock?: { key_item_name?: string }; container?: ContainerSummary }
  | { type: "container"; id: string; kind: string; x: number; y: number; itemCount: number }
  | { type: "npc"; id: string; x: number; y: number };

/** One line of a context menu. `act` sends `act`; `container` sends `container_action` (verb open). */
export interface VerbOption {
  label: string;
  send: "act" | "container";
  verb: ActVerb | "open";
  target_id: string;
  hint?: string;
  /** Needs the actor next to the target (examining and reading reach further). */
  needsReach: boolean;
}

/** Only the verbs that make sense for this kind of thing in its current state. */
export function verbsFor(t: Target): VerbOption[] {
  const act = (verb: ActVerb, label: string, needsReach = true, hint?: string): VerbOption =>
    ({ label, send: "act", verb, target_id: t.id, needsReach, ...(hint ? { hint } : {}) });
  const examine = act("examine", "Examine", false);
  if (t.type === "npc") return [act("talk", "Talk", false), examine];
  if (t.type === "container") {
    if (t.kind === "pockets") return [examine];
    return [
      { label: t.itemCount > 0 ? "Look through" : "Look", send: "container", verb: "open", target_id: t.id, needsReach: true },
      examine,
    ];
  }
  const locked = t.state === "locked";
  const lockVerbs = (): VerbOption[] => {
    const key = t.lock?.key_item_name;
    // A lock without a named key cannot be opened with one; an unknown lock still offers every way.
    const unlock = !t.lock || key ? [act("unlock", "Unlock", true, key ? `needs ${key}` : undefined)] : [];
    return [...unlock, act("pick_lock", "Pick lock"), act("force", "Force")];
  };
  switch (t.kind) {
    case "door":
      return [...(locked ? lockVerbs() : t.state === "open" ? [act("close", "Close")] : [act("open", "Open")]), examine];
    case "chest": {
      if (locked) return [...lockVerbs(), examine];
      if (t.state === "open") return [act("open", "Look inside"), act("close", "Close"), examine];
      return [act("open", "Open"), examine];
    }
    case "lever": return [act("pull", "Pull", true, t.state === "open" ? "pulled" : undefined), examine];
    case "sign": return [act("read", "Read", false), examine];
    default: return [act("interact", "Interact"), examine]; // altar and anything new: left to the DM
  }
}

export interface VerbState { disabled: boolean; hint?: string }

/** Disabled with an explanation when the actor is out of reach. With no position the server decides. */
export function reachState(opt: VerbOption, me: Pt | null, target: Pt): VerbState {
  const base = opt.hint ? { hint: opt.hint } : {};
  if (!me) return { disabled: false, ...base };
  const reach = opt.needsReach ? REACH : EXAMINE_REACH;
  if (cheb(me, target) > reach) return { disabled: true, hint: opt.needsReach ? "too far" : "too far to see" };
  return { disabled: false, ...base };
}

/** Everything on the map that has a menu. A chest is one target: the interactable with its container attached. */
export function targetsOnMap(map: GameMap | null, containers: Record<string, ContainerSummary>, entities: readonly EntityView[]): Target[] {
  const out: Target[] = [];
  const claimed = new Set<string>();
  for (const l of map?.layers ?? []) {
    if (l.type !== "objectgroup") continue;
    for (const o of l.objects) {
      if (o.type !== "interactable") continue;
      const container = Object.values(containers).find((c) => c.object_id === o.id);
      if (container) claimed.add(container.id);
      out.push({
        type: "interactable", id: o.id, kind: o.kind, state: o.state, x: o.x, y: o.y,
        ...(o.lock ? { lock: o.lock } : {}), ...(container ? { container } : {}),
      });
    }
  }
  for (const c of Object.values(containers)) {
    if (claimed.has(c.id) || c.kind === "chest") continue;
    out.push({ type: "container", id: c.id, kind: c.kind, x: c.x, y: c.y, itemCount: c.item_count });
  }
  for (const e of entities) if (e.kind === "npc") out.push({ type: "npc", id: e.id, x: e.x, y: e.y });
  return out;
}

export function targetTitle(t: Target, entities: Record<string, EntityView>): string {
  if (t.type === "npc") return entities[t.id]?.name ?? "Someone";
  if (t.type === "container") return t.kind === "remains" ? "Remains" : t.kind === "pockets" ? "Pockets" : "Pile of items";
  const empty = t.container && t.container.item_count === 0 && t.state === "open";
  return `${t.kind.charAt(0).toUpperCase()}${t.kind.slice(1)}${empty ? " (empty)" : ""}`;
}

// ---------- inventory ----------

export interface ItemActions {
  canDrop: boolean;
  canGive: boolean;
  /** Why a button is disabled, for its tooltip. */
  dropReason?: string;
  giveReason?: string;
  recipients: { id: string; name: string }[];
}

export const BOUND_REASON = "Weapons and armor are bound to you and cannot be dropped or given.";

/** Drop and give rules for one item of my own pack: bound gear never moves; give needs an adjacent party member. */
export function itemActions(item: Pick<Item, "kind">, me: Pt | null, myId: string, party: readonly CharacterView[], entities: Record<string, EntityView>): ItemActions {
  const recipients = me
    ? party.filter((c) => c.id !== myId && entities[c.id] && cheb(me, entities[c.id]!) <= REACH).map((c) => ({ id: c.id, name: c.name }))
    : [];
  if (NO_TRANSFER.includes(item.kind)) {
    return { canDrop: false, canGive: false, dropReason: BOUND_REASON, giveReason: BOUND_REASON, recipients };
  }
  const canGive = recipients.length > 0;
  return {
    canDrop: true, canGive, recipients,
    ...(canGive ? {} : { giveReason: "No party member is next to you." }),
  };
}
