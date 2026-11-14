import type { CharacterView, ContainerSummary, EntityView, GameMap, InteractableView, Item, MapObject } from "@aedm/schemas";
import { EXAMINE_REACH, REACH, cheb, type Pt } from "../util/interact";

/**
 * Offline stand-in for the engine's containers, locks, doors and levers, so the UI can be tried with `?mock=1`.
 * It keeps the same message shapes as the real server and changes the map's interactables in place.
 */

type Interactable = Extract<MapObject, { type: "interactable" }>;
type ContainerKind = ContainerSummary["kind"];

interface MockContainer {
  id: string;
  kind: ContainerKind;
  x: number;
  y: number;
  items: Item[];
  label?: string;
  objectId?: string;
}

export interface LootHost {
  map(): GameMap;
  me(): EntityView | undefined;
  /** The player's own character, whose pack changes. */
  mine(): CharacterView | undefined;
  party(): CharacterView[];
  entities(): Record<string, EntityView>;
  emit(type: string, payload: unknown, ack?: string): void;
  fail(code: string, message: string, ack?: string): void;
  engine(text: string): void;
  /** Sends a state_diff with the extra fields. */
  diff(extra: Record<string, unknown>): void;
  snapshot(): void;
  /** Rolls d20 + modifier against dc, announces it, and says whether it passed. */
  roll(label: string, modifier: number, dc: number): boolean;
}

let itemN = 0;
const item = (name: string, kind: Item["kind"], value: number, tier?: number): Item =>
  ({ id: `it_mock_${++itemN}`, name, kind, value, ...(tier ? { tier } : {}) });

/** The starting pack for the player's character. */
export function starterPack(): Item[] {
  return [
    item("Rusty Sword", "weapon", 10, 1), item("Padded Vest", "armor", 12, 1), item("Healing Draught", "consumable", 15),
    item("Lucky Button", "trinket", 2), item("Pale Wick", "quest", 0),
  ];
}

const STOCK: Record<string, () => Item[]> = {
  chest_plaza: () => [item("Tower key", "quest", 0), item("Silver Ring", "trinket", 25, 1)],
  chest_stall: () => [item("Honeyed Bread", "consumable", 3), item("Copper Charm", "trinket", 8)],
  chest_tower: () => [item("Marsh Spear", "weapon", 40, 2), item("Ward Cloak", "armor", 35, 2), item("Spark Vial", "consumable", 20, 2)],
  chest_vault: () => [item("Rune Blade", "weapon", 80, 3)],
  chest_camp: () => [item("Trail Rations", "consumable", 4)],
};

/** Traps the offline map keeps out of the map payload until a search finds them (like the real server's hidden objects). */
const HIDDEN_TRAPS: Record<string, Interactable[]> = {
  m_hollowmere: [{ type: "interactable", id: "trap_hidden", kind: "trap", state: "closed", x: 16, y: 11 }],
};

const objects = (map: GameMap): MapObject[] => map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : []));
const interactables = (map: GameMap): Interactable[] => objects(map).filter((o): o is Interactable => o.type === "interactable");

export class MockLoot {
  private byMap = new Map<string, Map<string, MockContainer>>();
  private n = 0;
  private found = new Set<string>();
  private prayed = false;

  constructor(private host: LootHost) {}

  reset(): void {
    this.byMap.clear();
    this.n = 0;
    this.found.clear();
    this.prayed = false;
  }

  /** Search: reveals hidden traps within sight of me (the offline stand-in always succeeds when close enough). */
  search(): void {
    const me = this.host.me();
    const map = this.host.map();
    const near = (HIDDEN_TRAPS[map.id] ?? []).filter((t) => !this.found.has(t.id) && (!me || cheb(me, t) <= EXAMINE_REACH));
    if (near.length === 0) { this.host.engine("You search carefully and find nothing."); return; }
    const layer = map.layers.find((l) => l.type === "objectgroup");
    for (const t of near) {
      this.found.add(t.id);
      if (layer?.type === "objectgroup") layer.objects.push({ ...t });
    }
    this.host.diff({ interactables_revealed: near.map((t) => ({ map_id: map.id, object: { ...t } })) });
    this.host.engine(near.length === 1 ? "You spot a trap hidden in the floor." : "You spot some traps hidden in the floor.");
  }

  private here(): Map<string, MockContainer> {
    const map = this.host.map();
    let m = this.byMap.get(map.id);
    if (!m) {
      m = new Map();
      this.byMap.set(map.id, m);
      for (const o of interactables(map)) {
        if (o.kind !== "chest") continue;
        const id = `cn_${++this.n}`;
        m.set(id, { id, kind: "chest", x: o.x, y: o.y, items: STOCK[o.id]?.() ?? [item("Loose Coins", "trinket", 5)], label: "Chest", objectId: o.id });
      }
      if (map.id === "m_hollowmere") {
        const id = `cn_${++this.n}`;
        m.set(id, { id, kind: "pile", x: 12, y: 13, items: [item("Dented Lantern", "trinket", 6), item("Spare Cloak", "armor", 9, 1)], label: "Pile of items" });
      }
    }
    return m;
  }

  private find(id: string): MockContainer | undefined {
    const m = this.here();
    return m.get(id) ?? [...m.values()].find((c) => c.objectId === id);
  }

  private obj(id: string): Interactable | undefined {
    return interactables(this.host.map()).find((o) => o.id === id);
  }

  private stateOf(c: MockContainer): string { return (c.objectId ? this.obj(c.objectId)?.state : undefined) ?? "closed"; }

  summaries(): ContainerSummary[] {
    return [...this.here().values()]
      .filter((c) => c.kind === "chest" || c.items.length > 0)
      .map((c) => ({
        id: c.id, kind: c.kind, x: c.x, y: c.y, item_count: c.items.length, locked: this.stateOf(c) === "locked", open: this.stateOf(c) === "open",
        ...(c.objectId ? { object_id: c.objectId } : {}),
      }));
  }

  private view(c: MockContainer, ack?: string): void {
    const locked = this.stateOf(c) === "locked";
    this.host.emit("container_view", { container_id: c.id, kind: c.kind, ...(c.label ? { label: c.label } : {}), items: locked ? [] : c.items.map((i) => ({ ...i })), locked }, ack);
  }

  private changed(c: MockContainer, views: InteractableView[] = []): void {
    const mapId = this.host.map().id;
    const gone = c.kind !== "chest" && c.items.length === 0;
    const s = this.summaries().find((x) => x.id === c.id);
    this.host.diff({
      ...(gone ? { containers_removed: [c.id] } : s ? { containers_changed: [s] } : {}),
      ...(views.length ? { interactables_changed: views.map((v) => ({ ...v, map_id: mapId })) } : {}),
    });
  }

  private set(o: Interactable, state: Interactable["state"]): InteractableView {
    o.state = state;
    return { map_id: this.host.map().id, id: o.id, state };
  }

  private near(p: Pt, reach: number, ack?: string): boolean {
    const me = this.host.me();
    if (me && cheb(me, p) <= reach) return true;
    this.host.fail("invalid_state", "You are too far away.", ack);
    return false;
  }

  private hasKey(name?: string): boolean {
    return !!name && !!this.host.mine()?.inventory?.some((i) => i.name.toLowerCase() === name.toLowerCase());
  }

  // ---------- act ----------

  /** Handles an `act` on a map object or container. Returns false when the target is not one of ours. */
  act(verb: string, target: string, ack: string): boolean {
    const o = this.obj(target);
    const c = this.find(target);
    if (!o && !c) return false;
    const p: Pt = o ?? c!;
    const kind = o?.kind ?? c!.kind;
    if (verb === "examine") { if (this.near(p, EXAMINE_REACH, ack)) this.host.engine(this.describe(o, c)); return true; }
    if (verb === "talk") { this.host.engine(`The ${kind} says nothing.`); return true; }
    if (verb === "read") {
      if (!o || o.kind !== "sign") { this.host.engine("There is nothing to read."); return true; }
      if (this.near(p, EXAMINE_REACH, ack)) this.host.engine(`The sign reads: "${o.text ?? "Weathered letters, too faded to read."}"`);
      return true;
    }
    if (!this.near(p, REACH, ack)) return true;
    this.host.emit("presence", { player_id: "p_me", status: "online" }, ack);
    const v = verb === "interact" ? this.natural(o) : verb;
    switch (v) {
      case "open": return this.open(o, c, ack);
      case "close": return this.close(o, c, ack);
      case "pull": return this.pull(o);
      case "disarm": return this.disarm(o);
      case "pray": return this.pray(o);
      case "unlock": case "pick_lock": case "force": return this.unlock(v, o, c);
      default: this.host.engine(`You study the ${kind}. Nothing obvious happens.`); return true;
    }
  }

  private natural(o?: Interactable): string {
    if (!o) return "open";
    if (o.kind === "lever") return "pull";
    if (o.kind === "sign") return "read";
    if (o.kind === "door") return o.state === "open" ? "close" : "open";
    if (o.kind === "altar") return "pray";
    return o.kind === "chest" ? "open" : "none";
  }

  private disarm(o?: Interactable): boolean {
    if (o?.kind !== "trap") { this.host.engine("There is nothing to disarm."); return true; }
    if (o.state === "open") { this.host.engine("The trap is already harmless."); return true; }
    if (!this.host.roll("Disarm: the trap", 3, 12)) { this.host.engine("The mechanism resists your tools."); return true; }
    this.host.diff({ interactables_changed: [this.set(o, "open")] });
    this.host.engine("Click. The trap is harmless now.");
    return true;
  }

  private pray(o?: Interactable): boolean {
    if (o?.kind !== "altar") { this.host.engine("There is nothing to pray to."); return true; }
    this.host.engine(this.prayed ? "The altar has nothing more to give you." : "A warm light settles over you. The altar's boon is yours.");
    this.prayed = true;
    return true;
  }

  private describe(o?: Interactable, c?: MockContainer): string {
    if (o?.kind === "chest") return o.state === "locked" ? "A chest, shut tight and locked." : o.state === "open" ? "An open chest." : "A chest, closed but not locked.";
    if (o?.kind === "door") return o.state === "locked" ? "A door, closed and locked." : o.state === "open" ? "A door, standing open." : "A door, closed.";
    if (o?.kind === "lever") return o.state === "open" ? "A lever, pulled down." : "A lever, pushed up.";
    if (o?.kind === "sign") return "A sign with writing on it.";
    if (o?.kind === "trap") return o.state === "open" ? "A trap, sprung or disarmed. Harmless now." : "A trap, armed. Something is set to spring here.";
    if (o?.kind === "altar") return "An altar, worn smooth by hands. It feels welcoming.";
    if (o) return `You study the ${o.kind}.`;
    return c?.kind === "remains" ? "The remains of something that did not make it." : "A pile of dropped items.";
  }

  private open(o: Interactable | undefined, c: MockContainer | undefined, ack: string): boolean {
    if (o?.kind === "door") {
      if (o.state === "locked") { this.host.engine("The door is locked."); return true; }
      if (o.state === "open") { this.host.engine("It is already open."); return true; }
      const ch = this.set(o, "open");
      this.host.diff({ interactables_changed: [ch] });
      return true;
    }
    const box = c ?? [...this.here().values()].find((x) => x.objectId === o?.id);
    if (!box) { this.host.engine(`You cannot open the ${o?.kind ?? "thing"}.`); return true; }
    const chest = box.objectId ? this.obj(box.objectId) : undefined;
    if (chest?.state === "locked") { this.view(box, ack); this.host.engine("The chest is locked."); return true; }
    const views = chest && chest.state !== "open" ? [this.set(chest, "open")] : [];
    this.view(box, ack);
    this.changed(box, views);
    return true;
  }

  private close(o: Interactable | undefined, c: MockContainer | undefined, ack: string): boolean {
    const door = o?.kind === "door" ? o : undefined;
    if (door) {
      const me = this.host.me();
      if (me && me.x === door.x && me.y === door.y) { this.host.fail("invalid_state", "Something is in the doorway.", ack); return true; }
      if (door.state !== "open") { this.host.engine("It is already shut."); return true; }
      this.host.diff({ interactables_changed: [this.set(door, "closed")] });
      return true;
    }
    const box = c ?? [...this.here().values()].find((x) => x.objectId === o?.id);
    const chest = box?.objectId ? this.obj(box.objectId) : undefined;
    if (!box || !chest || chest.state !== "open") { this.host.engine("It is not open."); return true; }
    this.changed(box, [this.set(chest, "closed")]);
    return true;
  }

  private pull(o?: Interactable): boolean {
    if (o?.kind !== "lever") { this.host.engine("There is nothing to pull."); return true; }
    const now = o.state === "open" ? "closed" : "open";
    const out = [this.set(o, now)];
    for (const id of o.links ?? []) {
      const d = this.obj(id);
      if (!d) continue;
      if (now === "open") { delete d.lock; out.push(this.set(d, "open")); } else if (d.state === "open") out.push(this.set(d, "closed"));
    }
    this.host.diff({ interactables_changed: out });
    this.host.engine(now === "open" ? "The lever clunks down. Somewhere, a bolt slides back." : "The lever creaks back up.");
    return true;
  }

  private unlock(verb: string, o?: Interactable, c?: MockContainer): boolean {
    const box = c ?? [...this.here().values()].find((x) => x.objectId === o?.id);
    const t = o ?? (box?.objectId ? this.obj(box.objectId) : undefined);
    if (!t || t.state !== "locked") { this.host.engine("It is not locked."); return true; }
    const dc = t.lock?.dc ?? 10;
    let ok: boolean;
    if (verb === "unlock") {
      ok = this.hasKey(t.lock?.key_item_name);
      this.host.engine(ok ? `The ${t.lock?.key_item_name} turns. Click.` : "You have nothing that fits this lock.");
    } else if (verb === "pick_lock") ok = this.host.roll(`Lockpicking: the ${t.kind}`, 3, dc);
    else { ok = this.host.roll(`Force: the ${t.kind}`, 2, dc + 2); this.host.engine(ok ? "The lock snaps for good." : "It holds, and the noise carries."); }
    if (!ok) return true;
    delete t.lock;
    this.host.diff({ interactables_changed: [this.set(t, "closed")], ...(box ? { containers_changed: [this.summaries().find((s) => s.id === box.id)!] } : {}) });
    return true;
  }

  // ---------- containers and pack ----------

  containerAction(verb: string, id: string, itemId: string | undefined, ack: string): void {
    const c = this.find(id);
    if (!c) return this.host.fail("not_found", "There is nothing like that here.", ack);
    if (verb === "open" || verb === "close") { this.act(verb, id, ack); return; }
    if (!this.near(c, REACH, ack)) return;
    const me = this.host.mine();
    if (!me) return;
    if (this.stateOf(c) === "locked") return this.host.fail("invalid_state", "It is locked.", ack);
    if (this.stateOf(c) === "closed" && c.kind === "chest") return this.host.fail("invalid_state", "Open it first.", ack);
    const idx = c.items.findIndex((i) => i.id === itemId);
    const taken = verb === "take_all" ? c.items.splice(0) : idx >= 0 ? c.items.splice(idx, 1) : [];
    if (taken.length === 0) return this.host.fail("not_found", "That item is no longer there.", ack);
    me.inventory = [...(me.inventory ?? []), ...taken];
    this.host.engine(`You take ${taken.map((i) => i.name).join(", ")}.`);
    this.view(c, ack);
    this.changed(c);
    this.host.snapshot();
  }

  inventoryAction(verb: string, itemId: string, to: string | undefined, ack: string): void {
    const me = this.host.mine();
    const it = me?.inventory?.find((i) => i.id === itemId);
    if (!me || !it) return this.host.fail("not_found", "You have no such item.", ack);
    if (it.kind === "weapon" || it.kind === "armor") return this.host.fail("invalid_state", `${it.name} is bound to you.`, ack);
    const spot = this.host.me();
    if (!spot) return;
    if (verb === "give") {
      const other = this.host.party().find((p) => p.id === to);
      const e = to ? this.host.entities()[to] : undefined;
      if (!other || !e || other.id === me.id) return this.host.fail("not_found", "There is nobody like that to give it to.", ack);
      if (cheb(spot, e) > REACH) return this.host.fail("invalid_state", `${other.name} is too far away.`, ack);
      me.inventory = me.inventory!.filter((i) => i.id !== itemId);
      other.inventory = [...(other.inventory ?? []), it];
      this.host.engine(`You give ${it.name} to ${other.name.split(" ")[0]}.`);
      this.host.snapshot();
      return;
    }
    me.inventory = me.inventory!.filter((i) => i.id !== itemId);
    let pile = [...this.here().values()].find((c) => c.kind === "pile" && c.x === spot.x && c.y === spot.y);
    if (!pile) {
      pile = { id: `cn_${++this.n}`, kind: "pile", x: spot.x, y: spot.y, items: [], label: "Pile of items" };
      this.here().set(pile.id, pile);
    }
    pile.items.push(it);
    this.host.engine(`You drop ${it.name}.`);
    this.host.diff({ containers_changed: this.summaries().filter((s) => s.id === pile!.id) });
    this.host.snapshot();
  }
}
