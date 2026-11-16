/** Creating NPCs and enemy creatures in the game state. Shared by the DM actions and the campaign installer. */
import type { Enemy, NpcRecord, SpriteRecipe } from "@aedm/schemas";
import { RULES } from "./data.ts";
import { isFactTrue, newId, occupiedTiles, tileKey, emit, type Entity, type Mut } from "./state.ts";
import { designSpriteOffline, spriteSeed } from "./sprites.ts";
import { allyStats } from "./threat.ts";
import { isWalkable } from "./map/index.ts";

const norm = (s: string) => s.trim().toLowerCase();

export interface NpcSpec {
  map_id: string;
  x: number;
  y: number;
  name: string;
  concept: string;
  role: NpcRecord["role"];
  sprite_tags: string[];
  appearance?: NpcRecord["appearance"];
  voice?: string | undefined;
}

/**
 * Create an NPC (record, entity and facts) on a walkable, free tile. Refuses with a reason when the map or tile is wrong,
 * the name belongs to a living NPC or a player character, or the facts say that person is dead. Allies get combat stats
 * for `partyLevel`; `sprites` (keyed by lowercase name) supplies an approved sprite, else one is designed offline.
 */
export function createNpcM(m: Mut, a: NpcSpec, ctx: { partyLevel: number; sprites?: Record<string, SpriteRecipe> | undefined }): { ok: true; id: string } | { ok: false; reason: string } {
  const s = m.s;
  const map = s.maps[a.map_id];
  if (!map) return { ok: false, reason: `unknown map ${a.map_id}` };
  if (!isWalkable(map, a.x, a.y)) return { ok: false, reason: `tile (${a.x},${a.y}) is not walkable` };
  if (occupiedTiles(s, a.map_id).has(tileKey(a.x, a.y))) return { ok: false, reason: `tile (${a.x},${a.y}) is occupied` };
  const name = a.name.trim();
  const living = Object.values(s.npcs).find((n) => n.alive !== false && norm(n.name) === norm(name));
  if (living) return { ok: false, reason: `an NPC named ${name} is already alive` };
  if (Object.values(s.characters).some((c) => norm(c.name) === norm(name))) return { ok: false, reason: `${name} is a player character` };
  if (isFactTrue(s, name, "is_alive", "false")) return { ok: false, reason: `the facts say ${name} is dead` };
  const id = newId(s, "npc");
  const disposition = RULES.npc.dispositionByRole[a.role];
  const rec: NpcRecord = {
    id, name, concept: a.concept, role: a.role, map_id: a.map_id, x: a.x, y: a.y, sprite_tags: a.sprite_tags,
    ...(a.appearance ? { appearance: a.appearance } : {}),
    alive: true, ...(disposition ? { disposition } : {}),
    ...(a.voice ? { voice: a.voice } : {}),
    last_seen_beat: s.turn,
  };
  s.npcs[id] = rec;
  const stats = a.role === "ally" ? allyStats(ctx.partyLevel) : undefined;
  if (stats) rec.stats = stats;
  const ent: Entity = {
    id, kind: "npc", name, mapId: a.map_id, x: a.x, y: a.y, hp: stats?.hp ?? 1, hpMax: stats?.hp ?? 1, conditions: [], shield: 0,
    sprite: ctx.sprites?.[norm(name)] ?? designSpriteOffline(
      { concept: `${a.concept} ${a.sprite_tags.join(" ")}`.trim(), ...(a.appearance ? { appearance: a.appearance } : {}), name, role: a.role, kind: "npc" },
      spriteSeed(m.rng),
    ), refId: id, cooldowns: {}, usesLeft: {}, checkBonuses: [],
    ...(disposition ? { disposition } : {}),
  };
  s.entities[id] = ent;
  if (!s.facts.some((f) => norm(f.subject) === norm(name) && f.predicate === "is_alive")) s.facts.push({ subject: name, predicate: "is_alive", object: "true" });
  s.facts = s.facts.filter((f) => !(norm(f.subject) === norm(name) && f.predicate === "located_at"));
  s.facts.push({ subject: name, predicate: "located_at", object: a.map_id });
  emit(m, { type: "npc_created", entityId: id, name, role: a.role, x: a.x, y: a.y });
  return { ok: true, id };
}

/**
 * Put one creature of an archetype on a tile (the caller has checked the tile). Named like the archetype, with a letter
 * suffix when `lettered` or when an earlier creature of the archetype exists. Hostile, with full HP and the archetype's uses.
 */
export function spawnEnemyM(m: Mut, arch: Enemy, mapId: string, x: number, y: number, lettered: boolean): Entity {
  const s = m.s;
  const n = (s.spawnCounts[arch.id as string] ?? 0);
  s.spawnCounts[arch.id as string] = n + 1;
  const name = lettered || n > 0 ? `${arch.name} ${String.fromCharCode(65 + (n % 26))}` : arch.name;
  const id = newId(s, "ei");
  const ent: Entity = {
    id, kind: "enemy", name, mapId, x, y, hp: arch.stats.hp, hpMax: arch.stats.hp,
    conditions: [], shield: 0, sprite: arch.sprite ?? designSpriteOffline(
      { concept: `${arch.concept} ${arch.sprite_tags.join(" ")}`.trim(), ...(arch.appearance ? { appearance: arch.appearance } : {}), name: arch.name, role: arch.role, kind: "enemy" },
      spriteSeed(m.rng),
    ), refId: arch.id as string,
    disposition: "hostile", cooldowns: {},
    usesLeft: Object.fromEntries(arch.abilities.filter((ab) => ab.id && ab.uses_per_rest !== undefined).map((ab) => [ab.id as string, ab.uses_per_rest as number])),
    checkBonuses: [],
  };
  s.entities[id] = ent;
  emit(m, { type: "entity_spawned", entityId: id, name, archetypeId: arch.id as string, x, y, mapId });
  return ent;
}
