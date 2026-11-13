/**
 * Moving items: open and close containers, take from them, drop onto the ground, give to an adjacent party member.
 * Every function returns the engine's usual `{ ok, state, events, error? }` and leaves the input state untouched.
 * In combat each verb costs what `interact.json` `combatCost` says (taking: the action; dropping and giving: the quick action).
 * The `rng` argument is part of the common signature; none of these rolls anything.
 */
import type { Character, Container, Item } from "@aedm/schemas";
import { actorOrError, chargeM, reachError } from "./actor.ts";
import { act, type ActionResult } from "./combat.ts";
import { createContainerM, labelOf, pileWithRoom, stockMapM, tidyContainerM } from "./containers.ts";
import { INTERACT, RULES } from "./data.ts";
import type { Rng } from "./rng.ts";
import { containerForObject, emit, type Entity, type GameState, type Mut } from "./state.ts";

/**
 * Raise the character's weapon tier or armor bonus when the item is better than what they use. Returns true if it did.
 * Shared by `grant_item` and taking from a container, so loot and DM gifts equip the same way.
 */
export function equipIfBetter(c: Character, item: Item): boolean {
  if (item.kind === "weapon" && item.tier !== undefined && item.tier > c.weapon_tier) {
    c.weapon_tier = item.tier;
    return true;
  }
  if (item.kind === "armor" && item.tier !== undefined) {
    const bonus = RULES.armorTierBonus[String(item.tier)] ?? 0;
    if (bonus > c.armor_bonus) {
      c.armor_bonus = bonus;
      return true;
    }
  }
  return false;
}

/** Whether another item fits in the character's pack under the gameplay cap (`inventoryCap`). */
export function packHasRoom(c: Character, extra = 1): boolean {
  return c.inventory.length + extra <= Math.min(INTERACT.inventoryCap, 100);
}

/**
 * Look up a container the actor can reach on their map, by container id or by the id of the chest (map object) it came from;
 * errors for unknown, far away or pockets of a living creature.
 */
function reachableContainer(m: Mut, actor: Entity, containerId: string): Container | string {
  stockMapM(m, actor.mapId);
  const c = m.s.containers[containerId] ?? containerForObject(m.s, actor.mapId, containerId);
  if (!c) return "there is no such container";
  const err = reachError(actor, c.map_id, c);
  if (err) return err;
  if (c.kind === "pockets") {
    const owner = c.owner_entity_id ? m.s.entities[c.owner_entity_id] : undefined;
    return `${owner?.name ?? "its owner"} is not handing that over`;
  }
  return c;
}

/** Open a container if it is not locked. Emits `container_opened` the first time. */
function openM(m: Mut, actor: Entity, c: Container): string | undefined {
  if (c.locked) return `the ${labelOf(c).toLowerCase()} is locked`;
  if (c.kind === "chest" && !c.opened) {
    c.opened = true;
    emit(m, { type: "container_opened", containerId: c.id, kind: c.kind, label: labelOf(c), itemCount: c.items.length, by: actor.id, byName: actor.name });
  }
  return undefined;
}

/**
 * Open a container within reach. A locked one refuses (unlock, pick or force it first). The server answers with
 * `containerView(state, containerId)`. Opening a pile or remains costs the same as a chest and changes nothing.
 */
export function openContainer(state: GameState, rng: Rng, actorId: string, containerId: string): ActionResult {
  return act(state, rng, "open_container", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const c = reachableContainer(m, actor, containerId);
    if (typeof c === "string") return c;
    const err = chargeM(m, actor, "open");
    if (err) return err;
    const was = c.opened === true;
    const locked = openM(m, actor, c);
    if (locked) return locked;
    if (c.kind !== "chest" && !was) {
      emit(m, { type: "container_opened", containerId: c.id, kind: c.kind, label: labelOf(c), itemCount: c.items.length, by: actor.id, byName: actor.name });
    }
    return undefined;
  });
}

/** Close an open chest. Piles and remains have nothing to close (it succeeds and does nothing). */
export function closeContainer(state: GameState, rng: Rng, actorId: string, containerId: string): ActionResult {
  return act(state, rng, "close_container", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const c = reachableContainer(m, actor, containerId);
    if (typeof c === "string") return c;
    const err = chargeM(m, actor, "close");
    if (err) return err;
    if (c.kind === "chest" && c.opened) {
      c.opened = false;
      emit(m, { type: "container_closed", containerId: c.id, label: labelOf(c), by: actor.id, byName: actor.name });
    }
    return undefined;
  });
}

function moveToPack(m: Mut, actor: Entity, c: Container, index: number): void {
  const ch = m.s.characters[actor.refId] as Character;
  const item = c.items.splice(index, 1)[0] as Item;
  ch.inventory.push(item);
  const equipped = equipIfBetter(ch, item);
  emit(m, {
    type: "item_taken", by: actor.id, byName: actor.name, itemId: item.id, name: item.name, kind: item.kind, value: item.value,
    ...(item.tier !== undefined ? { tier: item.tier } : {}), containerId: c.id, ...(equipped ? { equipped } : {}),
  });
}

/** Take one item. A closed, unlocked chest is opened first. The pack cap (`inventoryCap`) applies. */
export function takeItem(state: GameState, rng: Rng, actorId: string, containerId: string, itemId: string): ActionResult {
  return act(state, rng, "take_item", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const c = reachableContainer(m, actor, containerId);
    if (typeof c === "string") return c;
    const err = chargeM(m, actor, "take");
    if (err) return err;
    const locked = openM(m, actor, c);
    if (locked) return locked;
    const index = c.items.findIndex((i) => i.id === itemId);
    if (index < 0) return "that item is not in there";
    if (!packHasRoom(m.s.characters[actor.refId] as Character)) return "your pack is full";
    moveToPack(m, actor, c, index);
    tidyContainerM(m, c);
    return undefined;
  });
}

/** Take everything that fits, in order. Fails only when nothing fits; leftovers stay in the container. One action in combat. */
export function takeAll(state: GameState, rng: Rng, actorId: string, containerId: string): ActionResult {
  return act(state, rng, "take_all", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const c = reachableContainer(m, actor, containerId);
    if (typeof c === "string") return c;
    const err = chargeM(m, actor, "take_all");
    if (err) return err;
    const locked = openM(m, actor, c);
    if (locked) return locked;
    if (c.items.length === 0) return "there is nothing to take";
    const ch = m.s.characters[actor.refId] as Character;
    if (!packHasRoom(ch)) return "your pack is full";
    while (c.items.length > 0 && packHasRoom(ch)) moveToPack(m, actor, c, 0);
    tidyContainerM(m, c);
    return undefined;
  });
}

/** Drop an item on the actor's own tile: into a pile there that has room, else a new pile. Weapons and armor are bound on pickup and cannot be dropped. */
export function dropItem(state: GameState, rng: Rng, actorId: string, itemId: string): ActionResult {
  return act(state, rng, "drop_item", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    const ch = m.s.characters[actor.refId] as Character;
    const index = ch.inventory.findIndex((i) => i.id === itemId);
    if (index < 0) return "you are not carrying that";
    const item = ch.inventory[index] as Item;
    if (INTERACT.noTransferKinds.includes(item.kind)) return `${item.name} is bound to you and cannot be dropped`;
    const err = chargeM(m, actor, "drop");
    if (err) return err;
    const pile = pileWithRoom(m.s, actor.mapId, actor.x, actor.y, 1)
      ?? createContainerM(m, { kind: "pile", mapId: actor.mapId, x: actor.x, y: actor.y, label: "Dropped items" });
    ch.inventory.splice(index, 1);
    pile.items.push(item);
    emit(m, { type: "item_dropped", by: actor.id, byName: actor.name, itemId: item.id, name: item.name, containerId: pile.id, x: actor.x, y: actor.y });
    return undefined;
  });
}

/** Give an item to another party member standing next to the actor. Weapons and armor are bound and cannot be given. */
export function giveItem(state: GameState, rng: Rng, actorId: string, itemId: string, toCharacterId: string): ActionResult {
  return act(state, rng, "give_item", (m) => {
    const actor = actorOrError(m, actorId);
    if (typeof actor === "string") return actor;
    if (toCharacterId === actor.id) return "you cannot give something to yourself";
    const target = actorOrError(m, toCharacterId);
    if (typeof target === "string") return target === "unknown creature" ? "there is no such party member" : target;
    const reach = reachError(actor, target.mapId, target);
    if (reach) return `${target.name} is not next to you`;
    const ch = m.s.characters[actor.refId] as Character;
    const to = m.s.characters[target.refId] as Character;
    const index = ch.inventory.findIndex((i) => i.id === itemId);
    if (index < 0) return "you are not carrying that";
    const item = ch.inventory[index] as Item;
    if (INTERACT.noTransferKinds.includes(item.kind)) return `${item.name} is bound to you and cannot be given away`;
    if (!packHasRoom(to)) return `${target.name}'s pack is full`;
    const err = chargeM(m, actor, "give");
    if (err) return err;
    ch.inventory.splice(index, 1);
    to.inventory.push(item);
    emit(m, { type: "item_given", from: actor.id, fromName: actor.name, to: target.id, toName: target.name, itemId: item.id, name: item.name });
    return undefined;
  });
}
