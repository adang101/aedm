/**
 * Containers in game state: chests, piles of dropped items, the remains of defeated creatures and NPC pockets.
 * Everything here works on a mutation context and uses the seeded rng it is given (or one forked from it), so a
 * given state always produces the same contents. Taking items out is in inventory.ts; locks and doors in interact.ts.
 */
import type { Container, ContainerKind, ContainerView, Item, Lock } from "@aedm/schemas";
import { INTERACT } from "./data.ts";
import { emit, newId, containerForObject, type Entity, type GameState, type Mut } from "./state.ts";
import { rollLoot, lootTierForLevel } from "./loot.ts";
import { createRng, forkRng, hashSeed } from "./rng.ts";
import { lootCap } from "./rules.ts";
import { getObjects } from "./map/index.ts";

/** The rounded-down average level of the characters (minimum 1). */
export function partyLevelOf(s: GameState): number {
  const levels = Object.values(s.characters).map((c) => c.level);
  return levels.length === 0 ? 1 : Math.max(1, Math.floor(levels.reduce((a, b) => a + b, 0) / levels.length));
}

export interface ContainerSpec {
  kind: ContainerKind;
  mapId: string;
  x: number;
  y: number;
  items?: Item[];
  label?: string;
  locked?: boolean;
  lock?: Lock;
  opened?: boolean;
  objectId?: string;
  ownerEntityId?: string;
}

/** Add a container to the state. Ids come from the state counter (`cn_` plus a number). */
export function createContainerM(m: Mut, spec: ContainerSpec): Container {
  const s = m.s;
  const c: Container = {
    v: 1, id: newId(s, "cn"), kind: spec.kind, map_id: spec.mapId, x: spec.x, y: spec.y, items: [...(spec.items ?? [])],
    ...(spec.label ? { label: spec.label.slice(0, 60) } : {}),
    ...(spec.locked ? { locked: true } : {}),
    ...(spec.lock ? { lock: { ...spec.lock } } : {}),
    ...(spec.opened ? { opened: true } : {}),
    ...(spec.objectId ? { object_id: spec.objectId } : {}),
    ...(spec.ownerEntityId ? { owner_entity_id: spec.ownerEntityId } : {}),
  };
  s.containers[c.id] = c;
  return c;
}

/** What players call it. */
export function labelOf(c: Container): string {
  return c.label ?? (c.kind === "chest" ? "Chest" : c.kind === "pile" ? "Dropped items" : c.kind === "remains" ? "Remains" : "Pockets");
}

/** A pile or remains on this tile that has room for `count` more items. */
export function pileWithRoom(s: GameState, mapId: string, x: number, y: number, count: number): Container | undefined {
  return Object.values(s.containers).find(
    (c) => (c.kind === "pile" || c.kind === "remains") && c.map_id === mapId && c.x === x && c.y === y && c.items.length + count <= INTERACT.pileCap,
  );
}

/**
 * Empty piles and remains that came from nowhere in particular are removed once emptied. Chests, and containers made
 * from a map object (a loot slot), stay as empty records so stocking the map again does not refill them.
 */
export function tidyContainerM(m: Mut, c: Container): boolean {
  if (c.items.length > 0 || c.kind === "chest" || c.kind === "pockets" || c.object_id) return false;
  delete m.s.containers[c.id];
  return true;
}

/** The container as a player sees it after opening it; a locked one shows nothing. */
export function containerView(state: GameState, containerId: string): ContainerView | undefined {
  const c = state.containers[containerId];
  if (!c) return undefined;
  const locked = c.locked === true;
  return { container_id: c.id, kind: c.kind, label: labelOf(c), items: locked ? [] : c.items.map((i) => ({ ...i })), locked };
}

// ---------- stocking ----------

const pct = (value: number, p: number, times = 1): number => Math.floor((value * p * times) / 100);

/**
 * Make containers from the map's chests and loot slots, once. Contents are rolled from a stream seeded by the map's
 * own seed and the object's id (never from the state's rng), with the tier and budget of the party level now, so the
 * same map and level always give the same chest. Chest stock is scenery, not an encounter reward: it does not count
 * against `session.lootValueThisEncounter`. Safe to call again; returns how many containers it created.
 */
export function stockMapM(m: Mut, mapId: string): number {
  const s = m.s;
  const map = s.maps[mapId];
  if (!map) return 0;
  const level = partyLevelOf(s);
  const tier = lootTierForLevel(level);
  const cap = lootCap(level);
  let made = 0;
  const stream = (objectId: string) => createRng(hashSeed(map.meta.seed, mapId, objectId));
  for (const o of getObjects(map)) {
    if (o.type === "interactable" && o.kind === "chest" && !containerForObject(s, mapId, o.id)) {
      const items = rollLoot(stream(o.id), { tier, budgetValue: pct(cap, INTERACT.chest.budgetPct), maxItems: INTERACT.chest.maxItems, newId: () => newId(s, "it") });
      const locked = o.state === "locked";
      const lock = locked ? (o.lock ?? { dc: INTERACT.locks.dcByTier[String(INTERACT.locks.defaultTier)] ?? 10 }) : undefined;
      createContainerM(m, {
        kind: "chest", mapId, x: o.x, y: o.y, items, label: "Chest", objectId: o.id, locked, ...(lock ? { lock } : {}), opened: o.state === "open",
      });
      made++;
    } else if (o.type === "entity_slot" && o.role === "loot" && !containerForObject(s, mapId, o.id)) {
      const items = rollLoot(stream(o.id), {
        tier, budgetValue: pct(cap, INTERACT.slot.budgetPct, o.count), maxItems: INTERACT.slot.itemsPerCount * o.count, newId: () => newId(s, "it"),
      });
      createContainerM(m, { kind: "pile", mapId, x: o.x, y: o.y, items, label: "Loot", objectId: o.id });
      made++;
    }
  }
  return made;
}

// ---------- remains ----------

/**
 * A creature has been defeated: the contents of its pockets, plus (for an enemy) loot rolled by its role from
 * `interact.json`, become remains on its tile. Enemy loot comes out of what is left of the encounter's loot cap and counts
 * against it, exactly like `grant_item`; minions often drop nothing by weight. The roll uses a stream forked from the
 * rng, so a drop never shifts the rolls that follow in combat. Call it before the entity is removed.
 */
export function dropRemainsM(m: Mut, e: Entity): void {
  const s = m.s;
  const pockets = Object.values(s.containers).find((c) => c.kind === "pockets" && c.owner_entity_id === e.id);
  const items: Item[] = pockets ? [...pockets.items] : [];
  if (pockets) delete s.containers[pockets.id];
  if (e.kind === "enemy") {
    const role = s.archetypes[e.refId]?.role;
    const w = role ? INTERACT.remains.dropWeights[role] : undefined;
    if (role && w) {
      const level = partyLevelOf(s);
      const rng = forkRng(m.rng, `remains:${e.id}`);
      const total = w.nothing + w.loot;
      const drops = total > 0 && rng.int(1, total) > w.nothing;
      const budget = Math.min(pct(lootCap(level), INTERACT.remains.budgetPct[role] ?? 0), lootCap(level) - s.session.lootValueThisEncounter);
      if (drops && budget > 0) {
        const rolled = rollLoot(rng, { tier: lootTierForLevel(level), budgetValue: budget, maxItems: INTERACT.remains.maxItems[role] ?? 1, newId: () => newId(s, "it") });
        s.session.lootValueThisEncounter += rolled.reduce((n, i) => n + i.value, 0);
        items.push(...rolled);
      }
    }
  }
  if (items.length === 0) return;
  const label = `Remains of ${e.name}`;
  const into = pileWithRoom(s, e.mapId, e.x, e.y, items.length);
  const c = into ?? createContainerM(m, { kind: "remains", mapId: e.mapId, x: e.x, y: e.y, label, ownerEntityId: e.id });
  c.items.push(...items);
  emit(m, { type: "loot_dropped", containerId: c.id, sourceName: e.name, count: items.length, value: items.reduce((n, i) => n + i.value, 0), x: e.x, y: e.y });
}

/** Give an NPC pockets holding these items (for the DM or a map build). They become remains if the NPC falls. */
export function stashPocketsM(m: Mut, owner: Entity, items: Item[]): Container {
  const existing = Object.values(m.s.containers).find((c) => c.kind === "pockets" && c.owner_entity_id === owner.id);
  if (existing) {
    existing.items.push(...items);
    return existing;
  }
  return createContainerM(m, { kind: "pockets", mapId: owner.mapId, x: owner.x, y: owner.y, items, label: `${owner.name}'s belongings`, ownerEntityId: owner.id });
}
