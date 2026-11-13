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
| `dm_notes` | string | Optional, at most 100 words. Stored privately and never sent to clients. The latest few come back to the DM in its `<dm_notebook>` context block. |
| `importance` | integer | 1 to 5 |
| `high_stakes` | boolean | Default false. True routes the next call to the Strong tier. |

**DM actions**

| Action `type` | Fields | Engine validation |
| --- | --- | --- |
| `request_check` | target (character ID or "party"), ability (str, dex, con, int, wis, cha), dc, tags (0 to 2), advantage (none, advantage, disadvantage), reason (at most 120), on_success and on_failure (optional, 1 to 60 words each: plain text, second person, present tense) | DC clamped to 5 through 30; tags from the allowed list; target is present. After the engine rolls, the branch text for the result is shown as DM narration (tags stripped, clamped to 60 words) and is flavor only: it never changes HP, items or numbers. **Optional fields added; the DM response `v` stays 1** (old replies still parse). A follow-up DM call happens only when the matching branch is missing or the response has `high_stakes: true`. |
| `create_npc` | name, concept (at most 200), role (merchant, quest_giver, ally, bystander, villain), map_id, x, y, sprite_tags (0 to 5), appearance (optional, at most 160: look hint for the sprite designer), voice (optional, at most 80: speech style, kept in the NPC dossier) | Tile walkable and free; name not already used by a living NPC |
| `npc_say` | entity_id, text (at most 60 words) | Entity is a living creature in the scene, an NPC or an enemy (never a player character), and is not dead according to `world_facts`. The line is broadcast as chat; for an NPC record it (cut to 120 characters) is also kept in the dossier, and the last `npc.linesKept` stay. Enemies have no record, so nothing is kept for them. |
| `npc_note` | entity_id (an NPC id), note (at most 120) | The NPC exists and is alive (record and `world_facts`); it need not be in the scene. The note joins the NPC's `notes`; the last `npc.notesKept` stay and older ones drop. |
| `create_enemy` | concept (at most 200), role (minion, standard, elite, boss), setting_notes (at most 200), ref (optional; `en_` plus snake_case, at most 40), appearance (optional, at most 160: look hint for the sprite designer) | Runs the enemy builder; the result is validated and registered as an archetype under `ref` (or a generated ID), so a later `spawn_entity` in the same response can use `ref` as its `archetype_id` |
| `spawn_entity` | archetype_id, map_id, x and y or slot_id, count (1 to 6) | Archetype exists; tiles walkable; the encounter's threat total stays inside the budget for its difficulty |
| `start_combat` | participants (entity and character IDs), difficulty (easy, standard, hard, deadly) | Participants present; the engine rolls initiative |
| `end_combat` | reason (victory, flee, truce) | A combat is active |
| `apply_condition` | target, condition, turns (1 to 3) | Turns capped by level; conditions do not stack |
| `grant_item` | recipient, item (name, kind, value, tier) | Kind is consumable, weapon, armor, trinket or quest; value within the remaining loot cap; weapon and armor tier within the party's level |
| `update_quest` | quest_id, status (new, active, done, failed), note (at most 120) | Quest exists in the story bible, or status is new |
| `set_fact` | subject, predicate, object | Must not contradict `world_facts`. Reserved predicates: is_alive (true or false), located_at (map ID), disposition (friendly, neutral, wary, hostile), owns (item ID). Other predicates are free text up to 40 characters. |
| `generate_map` | brief (see Map brief) | `setting.layout` and `setting.environment` from the allowed lists, at most 12 rooms, size class limits. Unknown material ids resolve by id, then tag, then role. **Shape change (v2): `biome` is replaced by `setting`; the DM response `v` stays 1.** |
| `change_scene` | map_id, entry (spawn name) | Map exists; the party is at an exit, or the DM narrates the travel |
| `award_growth` | character_id, amount (1 to 25), reason (at most 120) | Session caps from `rules-numbers.md` |
| `complete_milestone` | milestone_id | Exists in the story bible and is not yet completed; the engine grants 100 growth to each present character. With a plot, a milestone of a later stage than the current one is rejected (stages complete in order); finishing the last open milestone of a stage advances the stage. |
| `adjust_plot` | stages (1 to 7): stage_id, goal (at most 300), milestones (1 to 4: id, description at most 300) | The campaign has a plot. Each stage id is in the plot, appears once, and comes after the current stage (the stage of the first incomplete milestone), so started stages and completed milestones never change. New milestone ids must not clash with kept milestones or each other, and the bible keeps at most 30. All or nothing: any bad entry rejects the action. The engine replaces the goals and milestones of those stages and keeps stage order. |
| `open_thread` | text (at most 160) | Fewer than `npc.maxOpenThreads` threads are open. The engine assigns the id (`th_` plus a number). Closed threads beyond `npc.maxThreads` are dropped oldest first. |
| `close_thread` | thread_id, resolution (at most 120, may be "") | The thread exists and is open. |
| `suggest_actions` | chips (2 to 4 strings, at most 4 words each) | Shown as quick-reply chips, mainly for phones |

The DM never changes HP, stats, dice results or inventory directly. Those change only as results of engine rules.

**Memory and continuity (additive; the DM response `v` stays 1)**

During combat (`GameState.combat` set) the engine refuses every action not in `npc.combatSafeActions`: `npc_say`, `apply_condition`, `request_check`, `end_combat`, `set_fact`, `npc_note`, `open_thread`, `close_thread`, `suggest_actions`, `update_quest`. The refusal reason is `<type> is not allowed during combat`. At most `npc.maxCombatConditions` (1) `apply_condition` is applied per response; later ones are refused. The engine's `applyDmActions` enforces it for every caller (`DmContext.conditionsApplied` carries the count when a caller applies a response one action at a time, as the server does), and the server skips its `create_enemy` and `generate_map` pre-passes for a refused action. This is a semantic change only: the DM response `v` stays 1.

The new `voice`, `npc_note`, `open_thread` and `close_thread` are optional fields and new action types, so older responses stay valid.

| Record | Fields |
| --- | --- |
| NPC record (`GameState.npcs`) | Beside id, name, concept, role, position, sprite_tags, appearance, disposition and alive: `voice` (optional, at most 80), `lines` (optional, strings of at most 120, newest last), `notes` (optional, strings of at most 120, newest last), `last_seen_beat` (optional integer: the beat counter `GameState.turn` when the NPC was created, spoke or got a note), `stats` (optional combat stat block: hp, defense, attack_bonus, speed, damage_dice. Only `ally` NPCs have one: the engine derives it at creation from the standard enemy for the party level, with hp and damage scaled by `npc.allyStatPct`. Their entity HP is `stats.hp`; other roles stay at 1 HP. Combat reads it through the same lookup as an enemy archetype's stats.) |
| Story thread (`GameState.threads`) | id, text (at most 160), status (`open` or `closed`), resolution (optional, at most 120). Missing in older saves means none. |

The numbers are in `packages/engine/data/rules.json` under `npc`: `linesKept` 3, `notesKept` 5, `dossierMax` 12 (NPCs listed to the DM), `allyStatPct` 75 (ally HP and damage as a percentage of the standard enemy), `maxCombatConditions` 1, `combatSafeActions` (the list above), `maxOpenThreads` 12, `maxThreads` 100.

Context blocks (see `docs/design.md`, Memory and continuity): `<combat>` (only while a fight is on: round, active creature and the initiative order, each with id, name, side, hp/hpMax, conditions and, for enemies, role, concept (at most 100 characters), behavior, morale and bloodied; model-written text is escaped), `<summaries>` (story so far plus recent chapters), `<dm_notebook>`, `<npcs>`, `<threads>`, and the current act inside `<pacing>` (inside `<campaign>` when the bible has no plot).

Save files (`SAVE_VERSION` stays 1): `summaries` (a list of cumulative summaries) is replaced by `story_so_far` (string) and `chapters` (the last 4 summaries, oldest first). A save with only `summaries` loads with its last entry as `story_so_far` and no chapters; a save whose state has no `threads` loads with none.

**Map brief (inside `generate_map`, v2)**

The brief describes a place in open-ended terms. The DM never writes tiles: the engine resolves the setting to a layout generator and a set of materials, and builds the map from a seed. (v1 briefs, with a `biome` field, are rejected.)

| Field | Rules |
| --- | --- |
| `setting` | Object, see below. Required. |
| `theme_tags` | 0 to 4 short words, such as marsh or fog, used for flavor and asset matching |
| `size_class` | small (20 to 30 tiles per side), medium (30 to 45) or large (45 to 60) |
| `rooms` | 1 to 12 objects: id, type (hall, chamber, corridor, courtyard, cave, outdoor, street, deck, vault, garden, shore), size (small, medium, large), connects_to (room IDs) |
| `points_of_interest` | 0 to 8 objects: kind (free text, at most 24 characters, such as altar or "drowned pipe organ"; the engine maps it to a decor material or an interactable), room_id |
| `entity_slots` | 0 to 8 objects: role (enemy, npc, boss, loot), room_id, count (1 to 6) |
| `exits` | 1 to 4 objects: side (north, south, east, west), label |

`setting`:

| Field | Rules |
| --- | --- |
| `name` | Free text, 1 to 40 characters ("sunken cathedral", "airship deck") |
| `preset` | Optional shortcut that fills any missing materials: forest, dungeon, desert, town, interior, cave, swamp, snowfield, mountain_pass, ruins, temple, castle, ship_deck, sewer, volcanic, crypt, library, market, farmland, beach. Preset data lives in the engine. |
| `layout` | Required. The layout generator: rooms_and_corridors, cave, open_field, settlement, trail, arena, maze or islands |
| `environment` | Required: indoor, outdoor or underground |
| `mood` | Required: bright, neutral, dim, dark or eerie |
| `materials` | Optional object. Per role, a list of entries, each a material id (snake_case) or a Material draft: `floor`, `path`, `wall`, `obstacle` (each 0 to 3), `liquid`, `hazard` (each 0 to 3), `decor` (0 to 6) |
| `density` | Optional: obstacles, liquid, hazards, each an integer 0 to 3 |

A brief with only `setting` (name, preset, layout, environment, mood) is valid. Whatever a role lacks is filled from the preset, then from role defaults.

**Palette**

The 33 master palette colors of `style-bible.md`, exported from `packages/schemas/src/palette.ts` as `PALETTE` (ramps grass, stone, earth, sand, water, fire, magic, skin, each `[dark, midDark, midLight, light]`), `OUTLINE_HEX` and `PALETTE_HEX`. `snapToPalette(hex)` returns the nearest palette color (weighted RGB distance, ties to the earlier entry) and `isHex` tests `#rrggbb`. The engine snaps every color a model proposes before storing it; stored materials, tiles and sprite palettes hold palette colors only.

**Material**

| Field | Rules |
| --- | --- |
| `id` | snake_case, starts with a letter, at most 32 characters |
| `name` | 1 to 40 characters |
| `role` | floor, path, wall, obstacle, liquid, hazard, decor or door |
| `color`, `accent` | `#rrggbb` (palette colors once the engine has resolved it) |
| `pattern` | none, dots, stripes, cross, bricks, planks, cobbles, tiles, waves, cracks, grain, grass, sand, speckle, rings, scales, runes, glow or lattice. Each is drawn by one small canvas routine. |
| `walkable`, `blocks_sight` | boolean. Role defaults: floor, path, hazard, decor, door are walkable and clear; wall is solid and blocks sight; obstacle and liquid are solid and clear. |
| `hazard` | Optional, hazard role only: damage_type, dice (NdM) |
| `tags` | 0 to 6 short words |
| `prompt_traits` | 0 to 120 characters, for the image model |

A **Material draft** (what the DM may write inline in a brief) differs in being lenient: `id` is optional (derived from `name`), `accent` is optional (derived from `color`), `pattern` is any word of at most 24 characters (the engine picks the closest allowed pattern, else none), `walkable` and `blocks_sight` are optional (role defaults), `tags` and `prompt_traits` default to empty, and colors are any `#rrggbb` (snapped).

**Sprite spec**

The standard for every NPC, enemy, character and prop sprite. The strict form is what is stored and sent; the web client composes it on the 48 x 64 canvas.

| Field | Rules |
| --- | --- |
| `kind`, `v` | "spec", 1 |
| `body` | humanoid, beast, avian, serpent, insectoid, amorphous, construct, spirit, plant or object |
| `size` | tiny, small, medium, large or huge |
| `palette` | primary, secondary, accent, detail: `#rrggbb` (palette colors once snapped) |
| `parts` | 0 to 6 objects: part (from the catalog), color (optional: primary, secondary, accent or detail), side (optional: left, right or both) |
| `glyph` | Optional, 1 to 2 characters |
| `pose` | Optional: idle, aggressive, cowering or floating |
| `traits` | 0 to 160 characters of image prompt traits. No names of real people, franchises or artists. |
| `image_asset_id` | Optional. Where generated art plugs in later. |

Part catalog, exported as `PART_GROUPS` and `PART_CATALOG`: **head** horns, antlers, hood, hat, helmet, crown, mask, halo, beard, long_hair, ears_pointed, glowing_eyes, extra_eyes; **body** robe, cloak, armor, scales, fur, shell, spikes, tentacles, wings, tail, fins, mane, roots, leaves, gears, crystals; **held** sword, axe, spear, bow, staff, wand, shield, lantern, book, tool, orb; **aura** aura, smoke, flames, sparkles, drips.

A **Sprite spec draft** is the sprite designer model's output: `kind`, `v`, `size`, `traits` are optional (size defaults to medium), colors are any `#rrggbb` (snapped), and `parts` entries take any `part` string of at most 24 characters, up to 12 entries. The engine drops names outside the catalog, keeps the first 6 parts and snaps colors; `body` must be valid.

`sprite_recipe` (characters) and an entity's `sprite` (views) are a union discriminated on `kind`: `spec` (above), `pixel` (below) or `shape` (circle, square, diamond, triangle or hex with color, accent, glyph). New content uses `spec` or `pixel`; `shape` stays valid for older saves and as a fallback drawing. Character create accepts any of them.

**Asset record** (server-side asset store; sprites are stored in `<data>/assets/assets.json`, materials and settings are schema only)

| Field | Rules |
| --- | --- |
| `id` | `as_` plus an id |
| `kind` | material, setting or sprite |
| `key` | `sha256(kind + normalized concept + normalized appearance)` as hex (normalized: lowercase, collapsed whitespace). The same concept and appearance get the same sprite across sessions. A sprite that came from the offline fallback (model failed or timed out after 4 s) is not stored, so the next request tries the model again. |
| `spec` | A Material, a setting spec (name, preset, layout, environment, mood) or a Sprite spec, matching `kind` |
| `created_at`, `uses` | ISO timestamp; integer 0 or more, how often it was handed out |

**Sprite pipeline.** `finalizeSpriteSpec` (engine) turns a draft into a valid spec: colors snapped, unknown parts dropped (aliases such as horn, cape, wizard hat map to catalog parts), duplicates removed, at most 6 parts, contradictions removed (one of hood/hat/helmet, crown never with hat or helmet but allowed with hood, one of horns/antlers, one of robe/armor, one of fur/scales/shell, one held item per hand), size clamped by role and body (minions at most medium, non-boss humanoids at most large, bosses at least medium), glyph from the name, traits cleaned. `designSpriteOffline` (engine) is the deterministic keyword designer used as the fallback. The model call uses purpose `sprite`, tier fast, and one repair at most.

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
| `behavior` | array | 2 to 3 strings, each at most 80 characters. The engine matches certain phrasings (`rules.ai.tactics` and `rules.ai.rangedPattern` in `rules.json`): ranged ("keeps its distance"), `focus_weakest` ("picks off the weakest"), `target_healer` ("goes for healers"), `protect_leader` ("guards its leader"), `pack` ("fights as a pack"), `fearless` ("fights to the death") and `cowardly` ("retreats when hurt"). Other lines are flavour. |
| `loot_hint` | string | 0 to 80 characters |
| `sprite_tags` | array | 0 to 5 short words |
| `appearance` | string | Optional, 0 to 160 characters. Look hint for the sprite designer, together with `concept`. |
| `sprite` | object | Optional Sprite spec, set by the server after the sprite designer runs (cached per concept). Every entity spawned from the archetype uses it; without it the engine designs one offline. |
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
| `abilities` | array | 1 to 3 ability objects at creation, up to 6 after level-ups (`abilityLimits.maxAbilitiesPerCharacter`), total cost within the level's power budget |
| `weapon_tier`, `armor_bonus` | integer | Within the level's allowance |
| `level`, `growth`, `hp`, `hp_max` | integer | Engine-owned. Clients cannot set them. |
| `sprite_recipe` | object | Discriminated on `kind`: `spec` (see Sprite spec; standard for new content), `pixel` (see Pixel sprite) or `shape` (shape: circle, square, diamond, triangle, hex; color and accent `#rrggbb`; glyph 1 to 2 characters; kept for backward compatibility) |
| `inventory` | array | Engine-owned |

**Character create (client submits for a new character)**

`v`, name, title, description, key_ability, scores (each 8 to 15; the engine checks the 27-point cost), trait_tags (exactly 2, different), sprite_recipe (optional; when absent the server designs a Sprite spec from title and description at claim time), and exactly one of `ability_texts` (1 to 3 strings, each at most 300 characters, sent to the forge) or `abilities` (1 to 3 prebuilt ability drafts). Engine-owned fields are rejected.

**WebSocket messages**

Every message is an object with `v`, `type`, `id` (client-generated and unique per session, used for idempotency), `ts` and `payload`. Server replies carry `ack_id`. Messages over 8 KB are rejected. A `v` mismatch returns `version_mismatch` and the client prompts a reload. `WS_VERSION` is 7 (containers, locks and doors: the `container_action` and `inventory_action` client messages, the `container_view` server message, more `act` verbs, and `containers` in `state_snapshot` and the container and interactable fields of `state_diff`; the Map schema stays v2 because its new fields are optional, but old clients would ignore door state and containers, so they reload); it was 6 for Workshop and cast messages (`custom_cast` and `custom_paintings` settings) and 5 for the following: the envelopes are unchanged, but the Map payload changed shape (v2 map), room settings gained `plot_pattern` and `plot_arc`, `design_sprite` and `sprite_designed` were added, and sprite recipes gained the `pixel` kind with the `invalid_sprite` error code, so old clients reload. Starting rate limits: `move_intent` 10 per second, `say` 1 per 2 seconds, everything else 5 per second; `design_sprite` is also limited per account (see Sprite designer).

| `type` | Direction | Payload |
| --- | --- | --- |
| `create_room` | Client to server | display_name (1 to 24 characters) |
| `room_created` | Server to client | room_id, invite_code |
| `join_room` | Client to server | invite_code, display_name (1 to 24), auth_token (optional; the reconnect token from `joined`) |
| `joined` | Server to client | player_id, auth_token, room_id |
| `lobby_state` | Server to client | room_id, invite_code, host_player_id, phase (lobby, playing), settings (content_rating family, teen or mature; campaign_pitch at most 300 characters; dev_solo boolean; plot_pattern and plot_arc, optional, a pattern or arc id or `auto`, missing means auto), players (player_id, display_name, status online, away, offline or autopilot, ready, character_id or null), resume_save (optional: save_id, name; set on a room opened by `resume_campaign`) |
| `set_ready` | Client to server | ready |
| `update_settings` | Client to server | Host only. Any subset of the `settings` fields |
| `start_game` | Client to server | Host only. None |
| `claim_character` | Client to server | character_id, or "new" plus a character object, or `"template"` plus `template_id` (accounts only: a saved character; the normal forge path runs) |
| `move_intent` | Client to server | target tile (x, y) or direction (n, s, e, w) |
| `act` | Client to server | verb (interact, examine, talk, open, close, unlock, pick_lock, force, pull, read), target_id (an entity id, an interactable id on the current map, or a container id). `interact` does the natural thing for the target: door open or close, lever pull, sign read, chest or pile open, a locked door or chest unlocked first if the actor carries its key; an altar or a creature is left to the DM. The engine answers it with no DM call except `narrative` results (see Containers, locks and doors). |
| `container_action` | Client to server | verb (open, close, take, take_all), container_id (or the id of a chest object), item_id (take only: required for `take`, rejected for the others). `open` is answered with `container_view`. |
| `inventory_action` | Client to server | verb (drop, give), item_id, to_character_id (give only: required for `give`, rejected for `drop`). Drop puts the item on the sender's own tile; give needs an adjacent party member. |
| `use_ability` | Client to server | ability_id, target (entity ID or tile) |
| `basic_attack` | Client to server | target_id |
| `use_item` | Client to server | item_id, target |
| `end_turn` | Client to server | none |
| `say` | Client to server | text (at most 500 characters), channel (ic or ooc). OOC never reaches the DM prompt. |
| `vote_cast` | Client to server | vote_id, choice (skip, wait, autopilot) |
| `request_save` | Client to server | name (at most 30 characters) |
| `load_save` | Client to server | save_id (host only; a save owned by an account loads only for that account) |
| `ping` | Client to server | none |
| `level_up_choice` | Client to server | Discriminated on `kind`: `score` (ability: str, dex, con, int, wis or cha), `new_ability` (text, 1 to 300 characters), `reforge` (ability_id, text 1 to 300), `skip_ability` (none). Applies to the sender's own character only; out of combat only. |
| `state_snapshot` | Server to client | seq, mode (exploration, combat), map (Map JSON, with each interactable's current state, lock and sign text), entities (EntityView), party (CharacterView), quests, combat (optional CombatState), containers (optional: a ContainerSummary for every chest on the map and every pile or remains that still holds something) |
| `state_diff` | Server to client | seq, ack_seq (optional), changed (EntityView list), removed (entity IDs), mode (optional), combat (optional CombatState), containers_changed (optional ContainerSummary list), containers_removed (optional container ids), interactables_changed (optional list of `map_id`, `id`, `state` for doors, levers and chests that changed) |
| `container_view` | Server to client | container_id, kind (chest, pile, remains, pockets), label (optional), items (Item list; empty while the container is locked), locked. Sent to the player who opened the container. |
| `narration_chunk` | Server to client | turn_id, text, done |
| `roll_result` | Server to client | who, label, dice (list of rolled die values), modifier, total, target (DC or Defense), outcome (success, failure, crit, fumble) |
| `combat_state` | Server to client | CombatState: round, order (entity_id and initiative, in turn order), active_id |
| `turn_timer` | Server to client | entity_id, seconds_left |
| `vote_state` | Server to client | vote_id, topic, options, tally, seconds_left |
| `map_load` | Server to client | map_id, url, content_hash |
| `presence` | Server to client | player_id, status (online, away, offline, autopilot) |
| `character_claimed` | Server to client | character_id, player_id |
| `save_created` | Server to client | save_id, name |
| `chips` | Server to client | 2 to 4 suggested quick replies |
| `chat` | Server to client | from_id, from_name, channel (ic, ooc, system), text |
| `log` | Server to client | kind (narration, system, roll, engine), text, turn_id (optional) |
| `error` | Server to client | code, message, ack_id (optional) |
| `pong` | Server to client | none |
| `level_up_state` | Server to client | Owner only. character_id, level, score_points, ability_picks, budget, budget_used, per_ability_cap, caps (max_avg, max_radius, max_stun_turns), max_abilities (optional), abilities (current, with cost), scores. Sent after a `level_up` event, after each choice, and on (re)connect while picks are pending. Zero score points and zero ability picks closes the level-up screen. |
| `level_up_result` | Server to client | Owner only, carries the choice's `ack_id`. ok, message, forge_notes (list), ability (optional: the ability learned or reforged). Rejections that need no forge (combat, nothing pending, wrong target) come back as `error` instead. |

**Level-up flow.** A `level_up` engine event (growth reaching 100 per level) gives the character one ability pick, plus one ability score point at levels 3, 6 and 9. The owner receives `level_up_state` and answers with `level_up_choice` messages until both counters are zero. `score` spends a point (a score never passes 20; max HP follows CON). `new_ability` and `reforge` forge the text at the character's current level through the same pipeline as character creation, clamp it to the level caps and to the power budget still free (a reforge frees the old ability's cost first), and reject it with a clear message when nothing fits. `skip_ability` keeps the abilities and clears one pick. Choices run on the room's serialized queue because forging calls the model. Each success broadcasts a system `log` line ("Brindle learned Chain Spark") and a `state_snapshot` with the new party view. In a room with `dev_solo` on, the OOC chat command `/dev grow <1-1000>` grants growth to the sender's character; with `dev_solo` off it does nothing but answer "Dev commands are disabled in this room."

Shared payload types: `EntityView` is id, kind (pc, npc, enemy), name, x, y, hp, hp_max, conditions (condition and turns), sprite (sprite recipe), and optional disposition and owner_player_id. `CharacterView` is the Character minus the private fields `user_id` and `campaign_id`, plus an optional `inventory` (additive, so the table can see the party's gear on the character sheet). `CombatState` is round, order and active_id.

The 8 KB limit applies to client-to-server messages. A `state_snapshot` carries a whole map and may be larger.

**Containers, locks and doors (engine-handled, no DM call)**

Chests, ground piles, defeated-enemy remains and NPC pockets are containers. They are engine state (`GameState.containers`, keyed by container id `cn_` plus a number) and are saved with the game. Doors, levers and signs keep what changed in `GameState.interactables`, keyed by `<map id>/<object id>`, because a map is shared and never mutated. The map object says how a thing was built; the game state says what it is now.

| Record | Fields |
| --- | --- |
| Container (`v` 1) | id, kind (chest, pile, remains, pockets), map_id, x, y, items (Item list, at most 100), label (optional, at most 60), locked and lock (optional, chests), opened (optional, chests), object_id (optional: the chest interactable or loot entity slot it was made from), owner_entity_id (optional: whose pockets or remains) |
| ContainerSummary | id, kind, x, y, item_count, locked, open, object_id (optional). What the whole table sees; never the items. |
| InteractableView | map_id, id, state (open, closed, locked). A door, lever or chest whose state changed. |
| Interactable override (`GameState.interactables`) | state (optional), lock (optional; `null` means the lock is gone), text (optional sign text) |

Where things live: a **chest** is both a map interactable and a container (`object_id` links them; its state is derived from the container: locked, open or closed). A **loot** entity slot becomes a `pile` container at the slot. A **pile** is created by `dropItem` on the dropper's tile and joined by later drops (at most `pileCap` items each). **Remains** appear where an enemy was defeated. **Pockets** belong to an NPC (`stashPocketsM`), cannot be opened while the NPC lives, and become remains when it dies. Containers are stocked when a map is added (`addMap`), from a stream seeded by the map's seed and the object id, with the party level at that moment: the loot tier is the level's gear allowance and a chest's budget is `interact.chest.budgetPct` of the encounter loot cap, so a chest never exceeds the cap. Chest stock is scenery and does not count against `session.lootValueThisEncounter`; remains drops come out of what is left of it and count against it, exactly like `grant_item`. A drop uses a stream forked from the rng, so it never shifts the combat rolls that follow.

Rules (numbers in `packages/engine/data/interact.json` and `loot.json`, summarised in `rules-numbers.md`):

- Reach: Chebyshev distance 1 to a container, door, lever or lock; signs and `examine` work from `examineReach` tiles. Pack cap `inventoryCap` (the schema's 100 stays the ceiling; `grant_item` still uses its own cap). Weapons and armor are bound on pickup (they equip like a granted item) and cannot be dropped or given.
- In combat every verb costs what `combatCost` says: taking, opening, doors, levers and locks the action; dropping and giving the quick action; reading and examining nothing. Only the active creature acts, and a verb set to `refuse` is not allowed.
- Locks: `unlock` opens with an item named like `key_item_name`, no roll. `pickLock` is a DEX check (tag lockpicking) and `forceOpen` a STR check (tag athletics, plus a bonus), both against the lock's DC through `checks.ts`. A failed pick has no lasting penalty. Forcing breaks the lock for good on success, and success or failure makes noise (a `noise` event with a radius, for the server and DM to use).
- Doors: a closed or locked door blocks movement (`occupiedTiles`, so pathfinding sees it) and sight (`sightBlockers`) until opened; it cannot be closed with a creature in the doorway. `interact.doors.blockWhenClosed` turns the blocking off.
- Levers flip themselves and each linked door (open doors close unless occupied; closed and locked ones open and lose the lock). Signs read their text (`readSign`, no DM call); `setSignText` writes one.
- `examine` returns a deterministic line for chests, doors, levers, signs, piles and remains. A closed container never reveals its contents. Altars, creatures and pockets come back `narrative: true` with no text: the engine did nothing and the DM should describe it. The same goes for `talk` and for `interact` on an altar or a creature.

Versioning. The Map stays v2 (its three new interactable fields are optional); the Container record is new at v1; the WebSocket protocol goes to 7 because there are new messages and snapshot fields. Object verbs are folded into `act` rather than a second message: `act` is already "do something to a thing on the map", and the engine's `performAct` is the single entry point. Moving items is separate (`container_action`, `inventory_action`) because it has its own payloads and replies.

Engine entry points for the server (all return `{ ok, state, events, error? }` unless noted; none mutate their input): `performAct(state, rng, actorId, verb, targetId)` (adds `narrative`, `text`, `containerId`, `success`), `openContainer`, `closeContainer`, `takeItem`, `takeAll`, `dropItem`, `giveItem`, `openDoor`, `closeDoor`, `unlock`, `pickLock`, `forceOpen`, `pullLever`, `readSign`, `setSignText(state, mapId, objectId, text)`, `examine`, and the pure `containerView(state, containerId)` for `container_view`, `containerSummaries(state, mapId)` and `effectiveMap(state, mapId)` for snapshots (`toSnapshot` already uses both), and `containerDiff(before, after, mapId)` for the `state_diff` container and interactable fields.

Save files (`SAVE_VERSION` stays 1): a state without `containers` or `interactables` loads with both empty, and `restoreState` stocks the chests and loot slots of every map it holds. Nothing else in an old save changes. Map generation takes two optional settings: `tier` (scales lock DCs, default 1) and `doorObjects` (turns the generator's door tiles into real door objects, default off until the client can open doors; both are in `interact.json`).

**Map JSON (v2)**

| Field | Rules |
| --- | --- |
| `v`, `id` | Version 2; `id` prefix `m_` |
| `width`, `height` | 20 to 60 tiles each |
| `tile_size` | 48 |
| `tileset` | Inline: `first_gid` (1) and `tiles` (1 to 256 TileDef objects). Replaces the v1 `tilesets` references, so the client can draw any map with no fixed catalog. |
| `layers` | Tile layers named `ground`, `walls`, `decor` and `above` (drawn over characters), plus one object layer named `objects` |
| Tile layer `data` | Array of width times height integers; 0 is empty, other values are `gid`s from the inline tileset. `walls` is the only collision layer: any non-zero value blocks movement and sight. |
| `meta` | setting (name, preset (optional), layout, environment, mood), theme_tags, seed (integer), template_id (optional), generated_at |

`TileDef`: gid (unique, 1 or more), material_id (snake_case), role (as Material), color and accent (`#rrggbb`), pattern (as Material), walkable, blocks_sight, variant (0 to 3, a visual variant of the same material), layer (ground, walls, decor or above), image_asset_id (optional).

Object types in the `objects` layer, all positioned in tiles:

| Object `type` | Fields |
| --- | --- |
| `spawn` | name. Exactly one named `party_start`. |
| `exit` | name, to (map ID or "pending"), target_entry (spawn name) |
| `entity_slot` | id (so `spawn_entity` can name it as `slot_id`), role (enemy, npc, boss, loot), count (1 to 6) |
| `interactable` | id, kind (chest, door, lever, sign, altar), state (open, closed, locked), and optional `lock` (chest and door only: `dc` 5 to 30 and optional `key_item_name`, at most 40 characters), `links` (lever only: 1 to 4 ids of door interactables on the same map) and `text` (sign only: 1 to 200 characters). The three optional fields are additive, so the Map stays v2 and older maps parse unchanged. The map's `state` is how it was built; what it is now lives in the game state (see Containers, locks and doors) and is merged into the `map` of every `state_snapshot`. |
| `trigger` | id, radius (1 to 3 tiles), on_enter (event name) |

A map is valid only if all of these hold. If any fails, regenerate with a new seed, up to 3 tries, then fall back (simplified rooms, the preset's own layout, one plain chamber).

1. Every layer's `data` length equals width times height.
2. Every non-zero tile ID has a TileDef in the inline tileset (the schema enforces this too, and that gids are unique).
3. `party_start` sits on a walkable tile.
4. Flood fill with 8-direction movement through non-wall tiles reaches every exit, entity slot and interactable from `party_start`.
5. No two objects share a tile.
6. Exits sit on walkable tiles on the map boundary or in a door tile.
7. The serialized map is at most 250 KB before compression.
8. Hazards are never the only way through: every exit, entity slot and interactable is reachable from `party_start` without stepping on a tile whose ground `TileDef` has role `hazard`. (A hazard's damage type and dice come from its material, found by `material_id` in the engine library.)

Doors and rule 4: a door object's tile is an ordinary walkable tile, so closed and locked doors count as passable for reachability. That is deliberate: a locked door or chest can always be picked or forced (a failed attempt has no lasting penalty), so a lock is never a dead end. The schema (not the validator) also checks that `lock` sits on a chest or door, `links` on a lever and `text` on a sign, and that every link names a door on the map.

The validator also warns, without failing, about `TileDef`s no layer uses; the generator never emits any. Tile layer placement: floor, path, door, hazard and walkable liquid go on `ground`; wall, obstacle and non-walkable liquid on `walls` (the collision layer, so a tree blocks sight as well as movement); decor props on `decor`; tree canopies on `above`. A `TileDef`'s `walkable` is false exactly when its layer is `walls`.

**Accounts**

Optional; guests use none of this. The login belongs to the connection and works before `create_room` or `join_room`. Wire limits are loose (max lengths only): the server checks the rules and answers `auth_error` with code `invalid`. Account messages without a login get `error` `forbidden`.

| `type` | Direction | Payload |
| --- | --- | --- |
| `register` | Client to server | username (3 to 20: letters, digits, `_`, `-`; stored lowercase), password (8 to 128), display_name (1 to 24) |
| `login` | Client to server | username, password |
| `resume_session` | Client to server | session_token |
| `logout` | Client to server | none |
| `auth_ok` | Server to client | user (id, username, display_name), session_token (only after `register` and `login`), characters (CharacterSummary list) |
| `auth_error` | Server to client | code (invalid_credentials, username_taken, invalid, rate_limited), message. Unknown user and wrong password are identical. |
| `logged_out` | Server to client | none |
| `list_characters` | Client to server | none |
| `characters_list` | Server to client | characters: id, name, title, key_ability, sprite_recipe, ability_names (up to 3), forged (boolean), saved_at. Also sent unrequested when a claim refreshes a template's forged abilities. |
| `save_character_template` | Client to server | character (a Character create object). Replaces a saved character with the same name. At most 20. Answered with `characters_list`. |
| `delete_character_template` | Client to server | id. Answered with `characters_list`. |
| `list_campaigns` | Client to server | none |
| `campaigns_list` | Server to client | campaigns: save_id, room_id (the save folder; autosave ids repeat), kind (autosave, named), name, campaign_title, updated_at (ISO), players (display names), can_resume |
| `resume_campaign` | Client to server | save_id, room_id. Opens a new lobby for a save the account owns and answers `room_created`; the client joins it, then the host sends `load_save`. |

Stored template (`data/accounts/users.json`, per user): id (`ch_...`), saved_at, character (the Character create object), forged_abilities (optional). Save files add `owner_user_id`, `campaign_title` and `room.player_user_ids` (player_id to account id); older saves without them are guest saves.

**Story structure (built)**

| Contract | Fields |
| --- | --- |
| Story bible `plot` | Optional (older saves parse without it): `{ pattern, arc, stages: [{ id, title (at most 60), goal (at most 300) }] }`. `pattern` is one of `overcoming_the_monster`, `rags_to_riches`, `the_quest`, `voyage_and_return`, `comedy`, `tragedy`, `rebirth`. `arc` is one of `rise`, `fall`, `fall_rise`, `rise_fall`, `rise_fall_rise`, `fall_rise_fall`. Stage ids are the pattern's five, in order (`packages/engine/data/plots.json`). |
| Milestone `stage` | Optional stage id. With a plot every milestone must carry one, every stage needs at least one milestone, and milestones are listed in stage order (engine `validateBiblePlot`; a bible that fails gets one repair call, then the built-in fallback). |
| Room settings | `plot_pattern` (a pattern id or `auto`) and `plot_arc` (an arc id or `auto`), both optional, missing means `auto`. `auto` is resolved by the engine (`pickPlot`) from the pitch keywords and the seed; an auto arc is one of the pattern's recommended arcs. Any explicit pairing is allowed. |
| DM action `adjust_plot` | See the action table. The DM response `v` stays 1 (an added action type only). |
| Engine events | `stage_advanced` (stageId, stageName, title) and `plot_adjusted` (stages), narrated to the DM as engine lines. |
| DM context | A `<pacing>` block built by the engine from the bible: plot and arc names, current stage with purpose and goal, next stage, tension target (0 to 10), fortune trend, suggested encounter difficulty. Milestone lines carry `stage=`. |

**Sprite designer (built, WS v4)**

| WS `type` | Direction | Payload |
| --- | --- | --- |
| `design_sprite` | Client to server | prompt (1 to 300), role_hint (`pc`, `npc`, `enemy`, `prop`), seed? (integer 0 to 2147483647; a new seed re-rolls the offline look), name? (1 to 30, only used for the glyph). Allowed in or out of a room. |
| `sprite_designed` | Server to client | spec (`SpriteSpec`, already finalized by the engine), notes (at most 20 short strings), source (`model` or `offline`). The envelope `ack_id` is the request's `id`; that is the request id. |

A refusal is an `error` with the same `ack_id`: `rate_limited` (6 calls per minute per account, per connection for guests; `DEFAULT_CONFIG.limits.spriteDesign`) or `bad_message` (empty or over-long prompt, unknown role). The result is not stored in the asset store. Error text never includes provider messages.

**Pixel sprite (built, WS v5)**

A player-painted sprite, recipe kind `pixel` (`PixelSpriteSchema`, `packages/schemas/src/pixel.ts`).

| Field | Rule |
| --- | --- |
| `kind`, `v` | `"pixel"`, `1` |
| `width`, `height` | exactly 48 and 64 |
| `palette` | 1 to 32 `#rrggbb` colors; the engine requires every one to be on the master palette (33 colors including the outline color) |
| `pixels` | Run-length encoded palette indices, 3072 in all. 0 is transparent and index `i` is `palette[i - 1]`. Each run is a symbol followed by a decimal count (omitted when 1). Symbols: `.` is 0, `A` to `Z` are 1 to 26, `a` to `f` are 27 to 32. A blank canvas is `.3072`. Helpers: `encodePixels`, `decodePixels`. |
| `size` | tiny to huge; scales the image with nearest-neighbor when drawn |
| `base` | Optional `SpriteSpec` it was painted over: fallback drawing and traits |
| `traits` | At most 160 characters |

Engine rules (`validatePixelSprite`, numbers in `packages/engine/data/pixel.json`): canvas size, every index inside the palette, every color on the master palette, at most 32 colors, at least 60 opaque pixels, no opaque pixel within 2 pixels of the edge, lowest opaque row within 4 of y = 60, and the recipe JSON at most 6144 bytes (so the whole create message stays under 8 KB). `shiftToFeet` moves an image vertically to put the feet on y = 60 when they are off by more than the tolerance and the margins allow it; the editor applies it on save. The server runs `validatePixelSprite` on every `claim_character` recipe of kind `pixel` (including saved templates) and refuses a failing one with the error code `invalid_sprite` and the reasons in the message. The renderer decodes once per sprite and falls back to `base`, then to a shape, if drawing fails.

**Workshop and campaign cast (built, WS v6)**

Schemas: `packages/schemas/src/workshop.ts`. Server: `apps/server/src/accounts/workshop.ts` (store), `workshop-handlers.ts`, and the cast handlers in `handlers.ts`.

| Contract | Fields |
| --- | --- |
| Workshop asset (wire) | `id` (`as_`), `name` (1 to 40), `role_hint` (`pc`, `npc`, `enemy`, `prop`), `concept` (0 to 200), `tags` (at most 5 short words), `recipe` (shape, spec or pixel), `source` (`designed` for shape and spec recipes, `painted_over` or `painted` for pixel recipes; the schema enforces the pairing), `created_at`, `updated_at`. The stored record adds `owner_user_id`, which never leaves the server. |
| Cast entry | `asset_id`, `owner_player_id`, `owner_name`, `name`, `role_hint`, `concept`, `recipe` (a snapshot taken at the offer), `status` (`pending`, `approved`) |
| `create_npc` / `create_enemy` | gain optional `asset_ref` (an `as_` id from the context pack's `<cast>` block). The DM response `v` stays 1 (an optional field). `Enemy.sprite` widened from a spec to any sprite recipe. |
| Room settings | gain `custom_cast` (`off`, `host_approval`, `open`; missing means `host_approval`) and `custom_paintings` (boolean; missing means true) |

Limits per account: 200 assets and 5 MB (the size is the JSON of the stored records). A pixel recipe is validated by the engine on save (`invalid_sprite`). Guests get `forbidden` ("Log in to use your Workshop"); over a limit gets `invalid_state`.

| WS `type` | Direction | Payload |
| --- | --- | --- |
| `save_sprite_asset` | Client to server | name, role_hint, concept, tags, recipe, source, id? (present: update the account's own asset; absent: create). Accounts only. Replies `sprite_assets_list`. |
| `delete_sprite_asset` | Client to server | id. Replies `sprite_assets_list`. |
| `list_sprite_assets` | Client to server | empty. |
| `sprite_assets_list` | Server to client | assets (newest first), used_bytes, max_assets, max_bytes. The envelope `ack_id` is the request's `id`. |
| `offer_to_cast` | Client to server | asset_id (from the sender's own Workshop). In a room, account only. Under `host_approval` the entry is `pending` (the host's own offers are `approved`); under `open` it is `approved`; under `off`, `forbidden`. Only `npc` and `enemy` looks can be offered, at most 10 per player and 60 per room; a pixel recipe is refused while `custom_paintings` is false. Replies `presence` (ok). |
| `cast_decision` | Client to server | asset_id, approve. Host: approve a pending entry, or deny or remove one (approve false). The offering player may withdraw their own entry (approve false). |
| `cast_state` | Server to client | entries (cast entries, pending and approved). Sent to everyone on every change and to a joining or reconnecting player. |

The cast is room state: it is not written to saves, and entries are visible only to players in the room where they were offered. `update_settings` is host-only; once the game has started it accepts only `custom_cast` and `custom_paintings`. Setting `custom_cast` to `open` approves every waiting entry. The DM's context lists approved `npc` and `enemy` entries (id, kind, name, concept up to 120 characters, neutralised as untrusted text; at most 20) while `custom_cast` is not `off`, and painted ones only while `custom_paintings` is on. `asset_ref` is checked on the server against that usable list and the action kind (`create_npc` takes `npc`, `create_enemy` takes `enemy`); anything else is ignored and the designed sprite is used. The beat never fails and the engine still decides all stats.
