/**
 * Doors, locks, levers, signs and examining: the mechanical parts of play that need no Dungeon Master call.
 * Every function returns the engine's usual `{ ok, state, events, error? }` and leaves the input state untouched.
 * Rolls (picking, forcing) use the seeded rng passed in and the same check machinery as DM checks.
 * What the engine cannot describe (an altar, a creature) comes back with `narrative: true` for the DM to handle.
 */
import type { ActVerb, CheckTag, Character, Container, Lock } from "@aedm/schemas";
import { SIGN_TEXT_MAX } from "@aedm/schemas";
import { actorOrError, chargeM, reachError } from "./actor.ts";
import { clampDc, rollCharacterCheck } from "./checks.ts";
import { act, type ActionResult } from "./combat.ts";
import { labelOf, stockMapM } from "./containers.ts";
import { INTERACT } from "./data.ts";
import { closeContainer, openContainer } from "./inventory.ts";
import { MapRng } from "./map/prng.ts";
import { signText } from "./map/signs.ts";
import { fromState, hashSeed, type Rng } from "./rng.ts";
import {
  containerForObject, effectiveLock, effectiveState, effectiveText, emit, findInteractable, objectKey,
  type Entity, type GameState, type InteractableObject, type Mut,
} from "./state.ts";

/** An `ActionResult` plus what the table needs to know about an `act`. */
export interface ActResult extends ActionResult {
  /** The engine has nothing to say or do: hand the action to the DM (an altar, a creature, `talk`). The state is unchanged. */
  narrative: boolean;
  /** `examine`: the description line. */
  text?: string;
  /** The container the action opened; the server answers with `containerView(state, containerId)`. */
  containerId?: string;
  /** `pick_lock` and `force`: whether the roll got the lock open. */
  success?: boolean;
}

interface Out { narrative?: boolean; text?: string; success?: boolean }

const norm = (s: string): string => s.trim().toLowerCase();
const fill = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
const itemsText = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;

function finishAct(r: ActionResult, out: Out): ActResult {
  return { ...r, narrative: out.narrative === true, ...(out.text !== undefined ? { text: out.text } : {}), ...(out.success !== undefined ? { success: out.success } : {}) };
}

function creatureOnTile(s: GameState, mapId: string, x: number, y: number): boolean {
  return Object.values(s.entities).some((e) => e.mapId === mapId && e.x === x && e.y === y);
}

function setObjectState(m: Mut, mapId: string, o: InteractableObject, state: "open" | "closed" | "locked", opts: { dropLock?: boolean; by?: Entity; via?: string } = {}): void {
  const key = objectKey(mapId, o.id);
  const ov = m.s.interactables[key] ?? {};
  m.s.interactables[key] = { ...ov, state, ...(opts.dropLock ? { lock: null } : {}) };
  emit(m, {
    type: "interactable_changed", mapId, objectId: o.id, kind: o.kind, state, x: o.x, y: o.y,
    ...(opts.by ? { by: opts.by.id, byName: opts.by.name } : {}), ...(opts.via ? { via: opts.via } : {}),
  });
}

/** A door on the actor's map. */
function doorOrError(m: Mut, actor: Entity, objectId: string, reach: number = INTERACT.reach): InteractableObject | string {
  const o = findInteractable(m.s, actor.mapId, objectId);
  if (!o || o.kind !== "door") return "there is no such door here";
  return reachError(actor, actor.mapId, o, reach) ?? o;
}

// ---------- doors ----------

/** Open a closed door. A locked one refuses: unlock, pick or force it first. An open door no longer blocks movement or sight. */
export function openDoor(state: GameState, rng: Rng, actorId: string, objectId: string): ActionResult {
  return act(state, rng, "open_door", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const o = doorOrError(m, actor, objectId);
    if (typeof o === "string") return o;
    const st = effectiveState(m.s, actor.mapId, o);
    if (st === "open") return "the door is already open";
    if (st === "locked") return "the door is locked";
    const err = chargeM(m, actor, "door");
    if (err) return err;
    setObjectState(m, actor.mapId, o, "open", { by: actor });
    return undefined;
  });
}

/** Close an open door (not while a creature stands in the doorway). A closed door blocks movement and sight. */
export function closeDoor(state: GameState, rng: Rng, actorId: string, objectId: string): ActionResult {
  return act(state, rng, "close_door", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const o = doorOrError(m, actor, objectId);
    if (typeof o === "string") return o;
    if (effectiveState(m.s, actor.mapId, o) !== "open") return "the door is already closed";
    if (creatureOnTile(m.s, actor.mapId, o.x, o.y)) return "something is standing in the doorway";
    const err = chargeM(m, actor, "door");
    if (err) return err;
    setObjectState(m, actor.mapId, o, "closed", { by: actor });
    return undefined;
  });
}

// ---------- locks ----------

interface LockTarget { obj: InteractableObject; container?: Container; lock: Lock }

/** A locked chest or door by interactable id, or a chest by container id. */
function lockTargetOrError(m: Mut, actor: Entity, targetId: string): LockTarget | string {
  stockMapM(m, actor.mapId);
  const s = m.s;
  let obj = findInteractable(s, actor.mapId, targetId);
  if (!obj) {
    const c = s.containers[targetId];
    if (c && c.map_id === actor.mapId && c.object_id) obj = findInteractable(s, c.map_id, c.object_id);
  }
  if (!obj || (obj.kind !== "door" && obj.kind !== "chest")) return "there is nothing here with a lock";
  const reach = reachError(actor, actor.mapId, obj);
  if (reach) return reach;
  const lock = effectiveLock(s, actor.mapId, obj);
  if (!lock) return `the ${obj.kind} is not locked`;
  const container = obj.kind === "chest" ? containerForObject(s, actor.mapId, obj.id) : undefined;
  return { obj, ...(container ? { container } : {}), lock };
}

/** Take the lock off: the door or chest becomes closed. */
function removeLockM(m: Mut, actor: Entity, t: LockTarget, method: "key" | "pick" | "force"): void {
  const mapId = actor.mapId;
  if (t.container) {
    t.container.locked = false;
    delete t.container.lock;
  }
  emit(m, { type: "unlocked", mapId, objectId: t.obj.id, kind: t.obj.kind, method, by: actor.id, byName: actor.name, ...(t.container ? { containerId: t.container.id } : {}) });
  if (t.obj.kind === "door") setObjectState(m, mapId, t.obj, "closed", { dropLock: true, by: actor });
  else emit(m, { type: "interactable_changed", mapId, objectId: t.obj.id, kind: t.obj.kind, state: "closed", x: t.obj.x, y: t.obj.y, by: actor.id, byName: actor.name });
}

/** Unlock with a key: succeeds automatically when the actor carries an item named like the lock's `key_item_name`. No roll. */
export function unlock(state: GameState, rng: Rng, actorId: string, targetId: string): ActionResult {
  return act(state, rng, "unlock", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const t = lockTargetOrError(m, actor, targetId);
    if (typeof t === "string") return t;
    const key = t.lock.key_item_name;
    if (!key) return "there is no keyhole to fit a key; pick the lock or force it";
    const ch = m.s.characters[actor.refId] as Character;
    const at = ch.inventory.findIndex((i) => norm(i.name) === norm(key));
    if (at < 0) return `you have no ${key}; pick the lock or force it`;
    const err = chargeM(m, actor, "lock");
    if (err) return err;
    if (INTERACT.locks.consumeKey) ch.inventory.splice(at, 1);
    removeLockM(m, actor, t, "key");
    return undefined;
  });
}

function rollLockM(m: Mut, actor: Entity, t: LockTarget, method: "pick" | "force", out: Out): void {
  const cfg = INTERACT.locks[method];
  const dc = clampDc(t.lock.dc + cfg.dcBonus);
  const roll = rollCharacterCheck(m, actor.refId, { ability: cfg.ability, dc, tags: [cfg.tag as CheckTag], advantage: "none", reason: `${method} the ${t.obj.kind} lock` }, dc);
  const success = roll?.success === true;
  out.success = success;
  if (success) removeLockM(m, actor, t, method);
  else emit(m, { type: "lock_failed", mapId: actor.mapId, objectId: t.obj.id, kind: t.obj.kind, method, by: actor.id, byName: actor.name });
  if (method === "force") emit(m, { type: "noise", mapId: actor.mapId, x: t.obj.x, y: t.obj.y, radius: INTERACT.locks.force.noiseRadius, source: actor.id, sourceName: actor.name });
}

function lockRoll(method: "pick" | "force") {
  return (state: GameState, rng: Rng, actorId: string, targetId: string): ActResult => {
    const out: Out = {};
    const r = act(state, rng, method === "pick" ? "pick_lock" : "force", (m) => {
      const actor = actorOrError(m, actorId);
      if (typeof actor === "string") return actor;
      const t = lockTargetOrError(m, actor, targetId);
      if (typeof t === "string") return t;
      const err = chargeM(m, actor, "lock");
      if (err) return err;
      rollLockM(m, actor, t, method, out);
      return undefined;
    });
    return finishAct(r, out);
  };
}

/**
 * Pick a lock: a DEX check (tag lockpicking) against the lock's DC. A failure costs the attempt (the action in combat) and can be
 * retried; there is no lasting penalty, so a lock is never a dead end. `success` says how the roll went; `ok` that it was attempted.
 */
export const pickLock = lockRoll("pick");

/**
 * Force a lock: a STR check (tag athletics) against the lock's DC plus the force bonus. Success breaks the lock for good. Success or
 * failure, it makes noise (a `noise` event with a radius from data) that the server and DM may use to wake the neighbours.
 */
export const forceOpen = lockRoll("force");

// ---------- levers and signs ----------

/**
 * Pull a lever: it flips (`open` pulled, `closed` not), and so does every door it links to: an open door closes (unless something
 * stands in it), a closed or locked one opens, its lock dropped. A lever with no links just flips.
 */
export function pullLever(state: GameState, rng: Rng, actorId: string, objectId: string): ActionResult {
  return act(state, rng, "pull_lever", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const lever = findInteractable(m.s, actor.mapId, objectId);
    if (!lever || lever.kind !== "lever") return "there is no such lever here";
    const reach = reachError(actor, actor.mapId, lever);
    if (reach) return reach;
    const err = chargeM(m, actor, "lever");
    if (err) return err;
    const next = effectiveState(m.s, actor.mapId, lever) === "open" ? "closed" : "open";
    setObjectState(m, actor.mapId, lever, next, { by: actor });
    const affected: string[] = [];
    for (const id of lever.links ?? []) {
      const door = findInteractable(m.s, actor.mapId, id);
      if (!door || door.kind !== "door") continue;
      if (effectiveState(m.s, actor.mapId, door) === "open") {
        if (creatureOnTile(m.s, actor.mapId, door.x, door.y)) continue;
        setObjectState(m, actor.mapId, door, "closed", { via: "lever", by: actor });
      } else {
        setObjectState(m, actor.mapId, door, "open", { dropLock: true, via: "lever", by: actor });
      }
      affected.push(door.id);
    }
    emit(m, { type: "lever_pulled", mapId: actor.mapId, objectId: lever.id, state: next, affected, x: lever.x, y: lever.y, by: actor.id, byName: actor.name });
    return undefined;
  });
}

/** The text of a sign: what was written (build time or `setSignText`), else a deterministic template line for this sign. */
export function signTextOf(s: GameState, mapId: string, sign: InteractableObject): string {
  const written = effectiveText(s, mapId, sign);
  if (written) return written;
  const map = s.maps[mapId];
  const rng = new MapRng(hashSeed(map?.meta.seed ?? 0, mapId, sign.id));
  return signText(map?.meta.setting.name ?? "", undefined, (arr) => rng.pick(arr));
}

/** Read a sign aloud to the table. No DM call. Costs nothing in combat. */
export function readSign(state: GameState, rng: Rng, actorId: string, objectId: string): ActionResult {
  return act(state, rng, "read_sign", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const sign = findInteractable(m.s, actor.mapId, objectId);
    if (!sign || sign.kind !== "sign") return "there is no such sign here";
    const reach = reachError(actor, actor.mapId, sign, INTERACT.examineReach);
    if (reach) return reach;
    const err = chargeM(m, actor, "read");
    if (err) return err;
    emit(m, { type: "sign_read", mapId: actor.mapId, objectId: sign.id, text: signTextOf(m.s, actor.mapId, sign), by: actor.id, byName: actor.name });
    return undefined;
  });
}

/** Write (or rewrite) a sign's text: 1 to 200 characters. For the DM and map tools; it needs no actor. */
export function setSignText(state: GameState, mapId: string, objectId: string, text: string): ActionResult {
  return act(state, fromState(state.rngState), "set_sign_text", (m) => {
    const sign = findInteractable(m.s, mapId, objectId);
    if (!sign || sign.kind !== "sign") return `there is no sign ${objectId} on ${mapId}`;
    const t = text.trim();
    if (t.length < 1 || t.length > SIGN_TEXT_MAX) return `sign text must be 1 to ${SIGN_TEXT_MAX} characters`;
    const key = objectKey(mapId, sign.id);
    m.s.interactables[key] = { ...(m.s.interactables[key] ?? {}), text: t };
    emit(m, { type: "sign_written", mapId, objectId: sign.id, text: t });
    return undefined;
  });
}

// ---------- examine ----------

/**
 * A deterministic description line for anything the engine understands: a chest, door, lever, sign, pile or remains, built from
 * its kind, state and (for an open container) how many items it holds. Closed containers never reveal contents. Altars,
 * creatures and NPC pockets have nothing to say: the result is `narrative: true`, no text, for the DM. Free in combat.
 */
export function examine(state: GameState, rng: Rng, actorId: string, targetId: string): ActResult {
  const out: Out = {};
  const r = act(state, rng, "examine", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    stockMapM(m, actor.mapId);
    const s = m.s;
    const texts = INTERACT.texts;
    const say = (kind: string, text: string, at: { x: number; y: number }, mapId: string): string | undefined => {
      const reach = reachError(actor, mapId, at, INTERACT.examineReach);
      if (reach) return reach;
      const err = chargeM(m, actor, "examine");
      if (err) return err;
      emit(m, { type: "examined", targetId, kind, text });
      out.text = text;
      return undefined;
    };
    const o = findInteractable(s, actor.mapId, targetId);
    if (o) {
      const st = effectiveState(s, actor.mapId, o);
      if (o.kind === "altar") { out.narrative = true; return undefined; }
      if (o.kind === "sign") return say("sign", texts.sign?.any ?? "", o, actor.mapId);
      if (o.kind === "lever") return say("lever", texts.lever?.[st === "open" ? "open" : "closed"] ?? "", o, actor.mapId);
      if (o.kind === "door") return say("door", texts.door?.[st] ?? "", o, actor.mapId);
      const c = containerForObject(s, actor.mapId, o.id);
      if (st !== "open" || !c) return say("chest", texts.chest?.[st] ?? "", o, actor.mapId);
      return say("chest", c.items.length === 0 ? (texts.chest?.empty ?? "") : fill(texts.chest?.open ?? "", { items: itemsText(c.items.length) }), o, actor.mapId);
    }
    const c = s.containers[targetId];
    if (c) {
      if (c.kind === "pockets") { out.narrative = true; return undefined; }
      if (c.kind === "chest") {
        const st = c.locked ? "locked" : c.opened ? "open" : "closed";
        const line = st !== "open" ? texts.chest?.[st] : c.items.length === 0 ? texts.chest?.empty : fill(texts.chest?.open ?? "", { items: itemsText(c.items.length) });
        return say("chest", line ?? "", c, c.map_id);
      }
      const name = labelOf(c).replace(/^Remains of /, "");
      const t = texts[c.kind];
      const line = c.items.length === 0 ? t?.empty : t?.any;
      return say(c.kind, fill(line ?? "", { name, items: itemsText(c.items.length) }), c, c.map_id);
    }
    if (s.entities[targetId]) { out.narrative = true; return undefined; }
    return "there is nothing like that here";
  });
  return finishAct(r, out);
}

// ---------- the one entry point for `act` ----------

type TargetKind = "door" | "chest" | "lever" | "sign" | "altar" | "container" | "creature" | "unknown";

function targetKindOf(s: GameState, actor: Entity | undefined, targetId: string): TargetKind {
  const o = actor ? findInteractable(s, actor.mapId, targetId) : undefined;
  if (o) return o.kind;
  const c = s.containers[targetId];
  if (c) return "container";
  if (s.entities[targetId]) return "creature";
  return "unknown";
}

function carriesKeyFor(s: GameState, actor: Entity | undefined, lock: Lock | undefined): boolean {
  const key = lock?.key_item_name;
  const ch = actor ? s.characters[actor.refId] : undefined;
  return !!key && !!ch && ch.inventory.some((i) => norm(i.name) === norm(key));
}

/**
 * Everything `act` can ask for, in one call: `interact` does the natural thing for the target (door: open or close, lever: pull, sign:
 * read, chest or pile: open, altar or creature: narrative; a locked door or chest is unlocked first when the actor carries its key),
 * the other verbs are explicit. Unknown or unsuitable targets come back as `ok: false` with a reason; `narrative: true` means the
 * engine did nothing and the DM should describe it.
 */
export function performAct(state: GameState, rng: Rng, actorId: string, verb: ActVerb, targetId: string): ActResult {
  const actor = state.entities[actorId];
  const kind = targetKindOf(state, actor, targetId);
  const refuse = (error: string): ActResult => ({ state, events: [{ type: "action_rejected", action: verb, reason: error }], ok: false, error, narrative: false });
  const plain = (r: ActionResult): ActResult => ({ ...r, narrative: false });
  const opened = (r: ActionResult): ActResult => {
    if (!r.ok) return plain(r);
    const o = actor ? findInteractable(r.state, actor.mapId, targetId) : undefined;
    const cid = o ? containerForObject(r.state, actor?.mapId ?? "", o.id)?.id : targetId;
    return { ...plain(r), ...(cid ? { containerId: cid } : {}) };
  };
  const lockOf = (): Lock | undefined => {
    if (!actor) return undefined;
    const o = findInteractable(state, actor.mapId, targetId) ?? (state.containers[targetId]?.object_id ? findInteractable(state, actor.mapId, state.containers[targetId]?.object_id ?? "") : undefined);
    return o ? effectiveLock(state, actor.mapId, o) : undefined;
  };
  const isLockable = kind === "door" || kind === "chest" || (kind === "container" && state.containers[targetId]?.kind === "chest");
  const isChest = kind === "chest" || kind === "container";

  switch (verb) {
    case "examine": return examine(state, rng, actorId, targetId);
    case "talk": return kind === "creature" ? { state, events: [], ok: true, narrative: true } : refuse("there is no one to talk to there");
    case "unlock": return isLockable ? plain(unlock(state, rng, actorId, targetId)) : refuse("there is nothing here with a lock");
    case "pick_lock": return isLockable ? pickLock(state, rng, actorId, targetId) : refuse("there is nothing here with a lock");
    case "force": return isLockable ? forceOpen(state, rng, actorId, targetId) : refuse("there is nothing here with a lock");
    case "pull": return kind === "lever" ? plain(pullLever(state, rng, actorId, targetId)) : refuse("there is nothing to pull");
    case "read": return kind === "sign" ? plain(readSign(state, rng, actorId, targetId)) : refuse("there is nothing to read");
    case "close":
      if (kind === "door") return plain(closeDoor(state, rng, actorId, targetId));
      return isChest ? plain(closeContainer(state, rng, actorId, targetId)) : refuse("that cannot be closed");
    case "open":
      if (kind === "door") return plain(openDoor(state, rng, actorId, targetId));
      return isChest ? opened(openContainer(state, rng, actorId, targetId)) : refuse("that cannot be opened");
    case "interact": {
      if (kind === "altar" || kind === "creature") return { state, events: [], ok: true, narrative: true };
      if (kind === "lever") return plain(pullLever(state, rng, actorId, targetId));
      if (kind === "sign") return plain(readSign(state, rng, actorId, targetId));
      if (kind === "unknown") return refuse("there is nothing like that here");
      if (isLockable && carriesKeyFor(state, actor, lockOf())) return plain(unlock(state, rng, actorId, targetId));
      if (kind === "door") {
        const o = actor ? findInteractable(state, actor.mapId, targetId) : undefined;
        const open = !!o && effectiveState(state, actor?.mapId ?? "", o) === "open";
        return plain(open ? closeDoor(state, rng, actorId, targetId) : openDoor(state, rng, actorId, targetId));
      }
      return opened(openContainer(state, rng, actorId, targetId));
    }
  }
}
