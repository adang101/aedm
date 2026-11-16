/**
 * Engine-written descriptions: short, deterministic, player-facing text built from the game state, so that looking
 * around, examining a creature and checking a pack need no Dungeon Master call. Pure. All phrasing and thresholds live
 * in `data/describe.json`.
 *
 * What these functions print is public to the table. They never read an NPC's `concept`, `notes`, `voice` or `lines`, or an
 * enemy's `concept` or `behavior` (DM-facing, may hold secrets), never the contents of a closed or locked container,
 * and never hit points as numbers.
 */
import { labelOf } from "./containers.ts";
import { DESCRIBE } from "./data.ts";
import { getObjects, hasLineOfSight, landmarkAt, mapLandmarks } from "./map/index.ts";
import { landmarkPhrase } from "./campaign-place.ts";
import {
  effectiveState, entitiesOnMap, interactablesOf, isHidden, sightBlockers,
  type Entity, type GameState,
} from "./state.ts";

const D = DESCRIBE;

const fill = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

/** "a", "a and b", "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(D.list.sep)}${D.list.last}${items[items.length - 1]}`;
}

/** The first `cap` items, then a closing "and N more" when some were left out. */
function capped(items: string[], cap: number): string {
  if (items.length <= cap) return joinList(items);
  return `${items.slice(0, cap).join(D.list.sep)}${D.list.sep}${fill(D.more, { n: String(items.length - cap) })}`;
}

const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** The health word for a creature: the percentage rounds up, so only a full-health creature is "unhurt". */
function healthWord(e: Pick<Entity, "hp" | "hpMax">): string {
  const pct = e.hp <= 0 ? 0 : Math.floor((e.hp * 100 + e.hpMax - 1) / Math.max(1, e.hpMax));
  return (D.healthBands.find((b) => pct >= b.minPct) ?? D.healthBands[D.healthBands.length - 1])?.text ?? "";
}

function conditionWords(e: Entity): string {
  const seen = new Set<string>();
  for (const c of e.conditions) seen.add(D.creature.conditions[c.condition] ?? c.condition);
  return joinList([...seen]);
}

// ---------- creatures ----------

/**
 * A creature as the table sees it. Enemy: name, appearance, health band, conditions. NPC: name, appearance, disposition.
 * Party member: name, title, health band, conditions. `undefined` for an unknown id.
 */
export function describeCreature(state: GameState, entityId: string): string | undefined {
  const e = state.entities[entityId];
  if (!e) return undefined;
  const C = D.creature;
  const conds = conditionWords(e);
  const appearance = (text: string | undefined): string => (text && text.trim() !== "" ? fill(C.appearance, { text: sentence(text) }) : "");
  if (e.kind === "enemy") {
    return fill(C.enemy, {
      name: e.name, appearance: appearance(state.archetypes[e.refId]?.appearance), health: healthWord(e),
      conditions: conds ? fill(C.enemyConditions, { list: conds }) : "",
    }).trim();
  }
  if (e.kind === "npc") {
    const rec = state.npcs[e.refId];
    const disposition = e.disposition ?? rec?.disposition ?? "neutral";
    return fill(C.npc, {
      name: e.name, appearance: appearance(rec?.appearance), disposition: C.dispositions[disposition] ?? "", downed: e.hp <= 0 ? C.downed : "",
    }).replace(/\s+$/, "").replace(/\s{2,}/g, " ").trim();
  }
  const ch = state.characters[e.refId];
  return fill(C.pc, {
    name: e.name, title: ch?.title ? fill(C.title, { title: ch.title }) : "", health: healthWord(e),
    conditions: conds ? fill(C.pcConditions, { list: conds }) : "",
  }).trim();
}

// ---------- the scene ----------

type Side = "n" | "s" | "e" | "w";

/** Which map edge an exit sits on, from its tile; undefined for an exit in the middle of the map. */
export function exitSide(map: { width: number; height: number }, at: { x: number; y: number }): Side | undefined {
  const m = D.exitEdgeMargin;
  const options: [number, Side][] = [[at.x, "w"], [map.width - 1 - at.x, "e"], [at.y, "n"], [map.height - 1 - at.y, "s"]];
  const near = options.filter(([d]) => d <= m).sort((a, b) => a[0] - b[0]);
  return near[0]?.[1];
}

function objectName(kind: string, state: string): string {
  const table = D.objectNames[kind];
  return table?.[state] ?? table?.any ?? fill(D.objectFallback, { kind });
}

function creatureTags(e: Entity): string {
  const tags: string[] = [];
  if (e.kind === "enemy" || e.disposition === "hostile") tags.push(D.tags.hostile);
  if (e.out) tags.push(D.tags.out);
  else if (e.hp <= 0) tags.push(D.tags.downed);
  return tags.length > 0 ? ` (${tags.join(", ")})` : "";
}

/**
 * What the character can see: the place, the ways out (with the map edge when known), objects in their current state,
 * piles and remains (never what is inside a closed or locked chest), the party, and the creatures in line of sight
 * (closed doors, walls and smoke hide the rest). Each list is capped by `describe.json`.
 */
export function describeScene(state: GameState, actorId: string): string {
  const actor = state.entities[actorId];
  const map = actor ? state.maps[actor.mapId] : undefined;
  if (!actor || !map) return D.scene.noPlace;
  const S = D.scene;
  const out: string[] = [];

  const setting = map.meta.setting;
  const mood = S.moods[setting.mood] ?? setting.mood;
  out.push(setting.name ? fill(setting.mood ? S.placeMood : S.place, { place: setting.name, mood }) : S.noPlace);

  // the landmarks of the place, and the one the character is standing at
  const landmarks = mapLandmarks(map);
  if (landmarks.length > 0) {
    const here = landmarkAt(map, actor.x, actor.y, 0);
    if (here) out.push(fill(S.at, { name: landmarkPhrase(here.name), description: here.description }));
    const others = landmarks.filter((l) => l.id !== here?.id).map((l) => landmarkPhrase(l.name));
    if (others.length > 0) out.push(fill(S.landmarks, { list: capped(others, D.caps.landmarks) }));
  }

  const exits = getObjects(map).flatMap((o) => {
    if (o.type !== "exit") return [];
    const side = exitSide(map, o);
    return [side ? fill(S.exitSide, { name: o.name, side: D.sides[side] }) : fill(S.exit, { name: o.name })];
  });
  if (exits.length > 0) out.push(fill(S.exits, { list: capped(exits, D.caps.exits) }));

  const objects: string[] = [];
  const mapObjectIds = new Set<string>();
  for (const o of interactablesOf(map)) {
    mapObjectIds.add(o.id);
    if (isHidden(state, map.id, o)) continue; // not found yet: the table does not know it is there
    const st = effectiveState(state, map.id, o);
    if (o.kind === "trap" && st !== "closed") continue; // a sprung or disarmed trap is not worth a mention
    objects.push(objectName(o.kind, st));
  }
  // chests that exist only as containers
  for (const c of Object.values(state.containers)) {
    if (c.map_id === map.id && c.kind === "chest" && !(c.object_id && mapObjectIds.has(c.object_id))) {
      objects.push(objectName("chest", c.locked ? "locked" : c.opened ? "open" : "closed"));
    }
  }
  if (objects.length > 0) out.push(fill(S.objects, { list: capped(objects, D.caps.objects) }));

  const ground = Object.values(state.containers)
    .filter((c) => c.map_id === map.id && (c.kind === "pile" || c.kind === "remains") && c.items.length > 0)
    .map((c) => (c.kind === "pile"
      ? D.containerNames.pile
      : fill(D.containerNames.remains, { name: labelOf(c).replace(/^Remains of /, "") })));
  if (ground.length > 0) out.push(fill(S.containers, { list: capped(ground, D.caps.containers) }));

  const blockers = sightBlockers(state, map.id);
  const others = entitiesOnMap(state, map.id).filter((e) => e.id !== actor.id && !state.absentEntityIds.includes(e.id));
  const party = others.filter((e) => e.kind === "pc").map((e) => `${e.name}${creatureTags(e)}`);
  if (party.length > 0) out.push(fill(S.party, { list: capped(party, D.caps.party) }));
  const seen = others
    .filter((e) => e.kind !== "pc" && hasLineOfSight(map, actor, e, blockers))
    .map((e) => `${e.name}${creatureTags(e)}`);
  if (seen.length > 0) out.push(fill(S.creatures, { list: capped(seen, D.caps.creatures) }));

  if (out.length === 1 && exits.length === 0 && objects.length === 0) out.push(S.nothing);
  return out.join(" ");
}

// ---------- the pack ----------

/** What the character carries, by name with counts for duplicates. (The character model has no equipped flag to report.) */
export function describeInventory(state: GameState, characterId: string): string {
  const items = state.characters[characterId]?.inventory ?? [];
  if (items.length === 0) return D.inventory.empty;
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n > 1 ? fill(D.inventory.count, { name, n: String(n) }) : name));
  return fill(D.inventory.carrying, { list: capped(parts, D.caps.inventory) });
}
