# Contracts

These plain-language definitions each become a Zod schema in `packages/schemas`; anything that fails validation is rejected, never silently patched.

**General rules**

- Every object and message carries `v`, a schema version integer that starts at 1.
- Unknown fields are rejected. Strings are trimmed. Lengths are in characters unless a rule says words.
- Coordinates are in tiles, not pixels, with (0, 0) at the top left.
- Any ID the model returns must exist in the context pack it was given, or the action is rejected.
- Allowed tags, conditions, damage types and terrain kinds are the lists in `rules-numbers.md`.

**DM response**

| Field | Type | Rules |
| --- | --- | --- |
| `v` | integer | 1 |
| `narration` | string | 40 to 150 words, plain text, no markup or HTML. Listed first so it can stream. |
| `actions` | array | 0 to 8 action objects, applied in order |
| `dm_notes` | string | Optional, at most 100 words. Stored privately and never sent to clients. |
| `importance` | integer | 1 to 5 |
| `high_stakes` | boolean | Default false. True routes the next call to the Strong tier. |

**DM actions**

| Action `type` | Fields | Engine validation |
| --- | --- | --- |
| `request_check` | target (character ID or "party"), ability (str, dex, con, int, wis, cha), dc, tags (0 to 2), advantage (none, advantage, disadvantage), reason (at most 120) | DC clamped to 5 through 30; tags from the allowed list; target is present |
| `create_npc` | name, concept (at most 200), role (merchant, quest_giver, ally, bystander, villain), map_id, x, y, sprite_tags (0 to 5) | Tile walkable and free; name not already used by a living NPC |
| `npc_say` | entity_id, text (at most 60 words) | Entity exists, is in the scene, and is not dead according to `world_facts` |
| `create_enemy` | concept (at most 200), role (minion, standard, elite, boss), setting_notes (at most 200) | Runs the enemy builder; the result is validated and an archetype ID returned |
| `spawn_entity` | archetype_id, map_id, x and y or slot_id, count (1 to 6) | Archetype exists; tiles walkable; the encounter's threat total stays inside the budget for its difficulty |
| `start_combat` | participants (entity and character IDs), difficulty (easy, standard, hard, deadly) | Participants present; the engine rolls initiative |
| `end_combat` | reason (victory, flee, truce) | A combat is active |
| `apply_condition` | target, condition, turns (1 to 3) | Turns capped by level; conditions do not stack |
| `grant_item` | recipient, item (name, kind, value, tier) | Kind is consumable, weapon, armor, trinket or quest; value within the remaining loot cap; weapon and armor tier within the party's level |
| `update_quest` | quest_id, status (new, active, done, failed), note (at most 120) | Quest exists in the story bible, or status is new |
| `set_fact` | subject, predicate, object | Must not contradict `world_facts`. Reserved predicates: is_alive (true or false), located_at (map ID), disposition (friendly, neutral, wary, hostile), owns (item ID). Other predicates are free text up to 40 characters. |
| `generate_map` | brief (see Map brief) | Biome from the allowed list, at most 12 rooms, size class limits |
| `change_scene` | map_id, entry (spawn name) | Map exists; the party is at an exit, or the DM narrates the travel |
| `award_growth` | character_id, amount (1 to 25), reason (at most 120) | Session caps from `rules-numbers.md` |
| `complete_milestone` | milestone_id | Exists in the story bible and is not yet completed; the engine grants 100 growth to each present character |
| `suggest_actions` | chips (2 to 4 strings, at most 4 words each) | Shown as quick-reply chips, mainly for phones |

The DM never changes HP, stats, dice results or inventory directly. Those change only as results of engine rules.

**Map brief (inside `generate_map`)**

| Field | Rules |
| --- | --- |
| `biome` | forest, dungeon, desert, town or interior (the five starter biomes) |
| `theme_tags` | 0 to 4 short words, such as marsh or fog, used for flavor and asset matching |
| `size_class` | small (20 to 30 tiles per side), medium (30 to 45) or large (45 to 60) |
| `rooms` | 1 to 12 objects: id, type (hall, chamber, corridor, courtyard, cave, outdoor), size (small, medium, large), connects_to (room IDs) |
| `points_of_interest` | 0 to 8 objects: kind (for example altar, statue, well), room_id |
| `entity_slots` | 0 to 8 objects: role (enemy, npc, boss, loot), room_id, count (1 to 6) |
| `exits` | 1 to 4 objects: side (north, south, east, west), label |

**Ability**

| Field | Type | Rules |
| --- | --- | --- |
| `v` | integer | 1 |
| `id` | string | Assigned by the engine, prefix `ab_` |
| `name` | string | 1 to 40 characters |
| `description` | string | 1 to 200 characters |
| `tags` | array | 0 to 2 allowed tags |
| `action` | enum | action or quick |
| `target` | enum | self, ally, enemy, any or tile |
| `range_tiles` | integer | 0 (self) to 12. 1 means adjacent. |
| `effects` | array | 1 to 4 effect objects |
| `cooldown_turns` | integer | 0 to 6. Present only when `uses_per_rest` is absent. |
| `uses_per_rest` | integer | 1 to 3. Present only when `cooldown_turns` is absent. |
| `cost` | integer | Computed by the engine. Ignored on input and recomputed on every load. |
| `forge_notes` | string | 0 to 200 characters. What the forge changed or refused, and why. |

**Effect objects**

| `type` | Fields | Limits |
| --- | --- | --- |
| `damage` | shape (single, burst, line, cone), radius_tiles (burst, 1 to 2), length_tiles (line up to 6, cone up to 4), dice (NdM with N from 1 to 8 and M one of 4, 6, 8, 10, 12), damage_type, save (optional: ability and dc "caster_dc"), on_save (half or none) | Average damage within the level cap |
| `heal` | shape (single or burst), radius_tiles, dice | Average healing within the level cap |
| `shield` | absorb (1 to 40), duration_turns | Duration 1 to 3 |
| `condition` | condition, duration_turns, on (hit, failed_save, always), save (optional) | Duration within the level cap; stunned within the stun cap |
| `push`, `pull` | tiles (1 to 4) | None |
| `dash` | tiles (1 to 8), with_attack (boolean) | None |
| `teleport` | tiles (1 to 6) | Needs line of sight |
| `mark` | duration_turns | Shorthand for the marked condition |
| `reveal` | radius_tiles (1 to 2) | None |
| `disarm` | none | Targets a trap or a lock |
| `terrain` | kind (wall, fire, trap, smoke), shape (tile, burst, line), radius_tiles or length_tiles, duration_turns (1 to 3, ignored for traps), dice and damage_type (fire and trap only) | Radius within the level cap |
| `check_bonus` | bonus (1 to 4), tags (1 to 2), duration_turns | Duration 1 to 3 |

Every effect may also carry `affects` (enemies, allies or all). Anything not in this table is unsupported, and the forge must say so in `forge_notes`.

**Enemy**

| Field | Type | Rules |
| --- | --- | --- |
| `v`, `id` | integer, string | `id` assigned by the engine, prefix `en_` |
| `name` | string | 1 to 40 characters |
| `concept` | string | 1 to 200 characters |
| `role` | enum | minion, standard, elite or boss |
| `stats` | object | hp, defense, attack_bonus, speed (tiles), damage_dice (basic attack NdM). Damage per round is computed by the engine. |
| `weakness`, `resistance` | enum or null | A damage type or a condition (weakness only) |
| `abilities` | array | 0 to 3 ability objects (minions 0) |
| `behavior` | array | 2 to 3 strings, each at most 80 characters, turned into a simple behavior tree |
| `loot_hint` | string | 0 to 80 characters |
| `sprite_tags` | array | 0 to 5 short words |
| `threat` | number | Computed by the engine from `rules-numbers.md`. Ignored on input. |

**Character**

| Field | Type | Rules |
| --- | --- | --- |
| `v`, `id`, `campaign_id`, `user_id` | | `user_id` is the account currently playing the character |
| `name` | string | 1 to 30 characters |
| `title` | string | 0 to 40 characters, such as "demolitions expert" |
| `description` | string | 0 to 300 characters. Screened before it reaches any image prompt. |
| `key_ability` | enum | str, dex, con, int, wis or cha |
| `scores` | object | The six ability scores. At creation they cost exactly 27 points and each is 8 to 15. |
| `trait_tags` | array | Exactly 2 allowed tags |
| `abilities` | array | 1 to 3 ability objects at creation, total cost within the level's power budget |
| `weapon_tier`, `armor_bonus` | integer | Within the level's allowance |
| `level`, `growth`, `hp`, `hp_max` | integer | Engine-owned. Clients cannot set them. |
| `sprite_recipe` | object | Part IDs and palettes, validated against the asset catalog |
| `inventory` | array | Engine-owned |

**WebSocket messages**

Every message is an object with `v`, `type`, `id` (client-generated and unique per session, used for idempotency), `ts` and `payload`. Server replies carry `ack_id`. Messages over 8 KB are rejected. A `v` mismatch returns `version_mismatch` and the client prompts a reload. Starting rate limits: `move_intent` 10 per second, `say` 1 per 2 seconds, everything else 5 per second.

| `type` | Direction | Payload |
| --- | --- | --- |
| `join_room` | Client to server | invite_code, auth_token |
| `claim_character` | Client to server | character_id, or "new" plus a character object |
| `move_intent` | Client to server | target tile (x, y) or direction (n, s, e, w) |
| `act` | Client to server | verb (interact, examine, talk), target_id |
| `use_ability` | Client to server | ability_id, target (entity ID or tile) |
| `basic_attack` | Client to server | target_id |
| `use_item` | Client to server | item_id, target |
| `end_turn` | Client to server | none |
| `say` | Client to server | text (at most 500 characters), channel (ic or ooc). OOC never reaches the DM prompt. |
| `vote_cast` | Client to server | vote_id, choice (skip, wait, autopilot) |
| `request_save` | Client to server | name (at most 30 characters) |
| `load_save` | Client to server | save_id (owner only) |
| `ping` | Client to server | none |
| `state_snapshot` | Server to client | Full scene state and `seq` |
| `state_diff` | Server to client | tick, changed entities, removed IDs, ack_seq |
| `narration_chunk` | Server to client | turn_id, text, done |
| `roll_result` | Server to client | who, label, dice, total, target number (DC or Defense), outcome |
| `combat_state` | Server to client | round, initiative order, active ID |
| `turn_timer` | Server to client | entity_id, seconds_left |
| `vote_state` | Server to client | vote_id, topic, options, tally, seconds_left |
| `map_load` | Server to client | map_id, url, content_hash |
| `presence` | Server to client | player_id, status (online, away, offline, autopilot) |
| `character_claimed` | Server to client | character_id, player_id |
| `save_created` | Server to client | save_id, name |
| `chips` | Server to client | 2 to 4 suggested quick replies |
| `error` | Server to client | code, message, ack_id |
| `pong` | Server to client | none |

**Map JSON**

| Field | Rules |
| --- | --- |
| `v`, `id` | Version 1; `id` prefix `m_` |
| `width`, `height` | 20 to 60 tiles each |
| `tile_size` | 48 |
| `tilesets` | 1 to 4 objects: asset_id, first_gid |
| `layers` | Tile layers named `ground`, `walls`, `decor` and `above` (drawn over characters), plus one object layer named `objects` |
| Tile layer `data` | Array of width times height integers; 0 is empty, other values are tile IDs from the tilesets. `walls` is the only collision layer: any non-zero value blocks movement and sight. |
| `meta` | biome, theme_tags, seed (integer), template_id (optional), generated_at |

Object types in the `objects` layer, all positioned in tiles:

| Object `type` | Fields |
| --- | --- |
| `spawn` | name. Exactly one named `party_start`. |
| `exit` | name, to (map ID or "pending"), target_entry (spawn name) |
| `entity_slot` | role (enemy, npc, boss, loot), count (1 to 6) |
| `interactable` | id, kind (chest, door, lever, sign, altar), state (open, closed, locked) |
| `trigger` | id, radius (1 to 3 tiles), on_enter (event name) |

A map is valid only if all of these hold. If any fails, regenerate with a new seed, up to 3 tries.

1. Every layer's `data` length equals width times height.
2. Every non-zero tile ID falls inside a tileset's range.
3. `party_start` sits on a walkable tile.
4. Flood fill with 8-direction movement through non-wall tiles reaches every exit, entity slot and interactable from `party_start`.
5. No two objects share a tile.
6. Exits sit on walkable tiles on the map boundary or in a door tile.
7. The serialized map is at most 250 KB before compression.
