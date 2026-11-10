# Design

AEDM ("Autonomous Enhanced Dungeon Master") is a browser game where an LLM runs the table for 2 to 6 players. Players host or join a lobby with an invite code, build characters, and play a campaign the DM generates and adapts as they go. The rules engine owns every number; the model proposes and the engine decides.

The other docs (`contracts.md`, `rules-numbers.md`, `spike-kit.md`, `style-bible.md`) are guides, followed loosely. Where the code deliberately diverges, this file says so.

## Architecture

```
apps/web  ──WebSocket (contracts.md messages)──▶  apps/server
 Canvas 2D renderer, lobby UI, chat, sheet         rooms, lobby, turn loop, persistence
                                                     │
                                  ┌──────────────────┼──────────────────┐
                                  ▼                  ▼                  ▼
                           packages/engine     packages/llm      packages/schemas
                           pure rules, RNG,    ModelProvider,     Zod contracts shared
                           mapgen, validators  prompts, DM/forge   by every package
                                               orchestration
```

| Package | Responsibility | May do I/O |
| --- | --- | --- |
| `packages/schemas` | Zod schemas for every contract; inferred TS types | No |
| `packages/engine` | Seeded RNG, dice, checks, attacks, combat, conditions, ability cost, threat, point buy, map generation and validation, DM action validation and application. Rules numbers in `data/*.json`. | No (no `Date`, no `Math.random`) |
| `packages/llm` | `ModelProvider` interface, Anthropic provider, fake provider, prompt files, context builder, DM turn / ability forge / enemy builder pipelines (parse, one repair, engine validation) | Network, via the provider only |
| `apps/server` | Node + `ws`. Lobbies, invite codes, presence, intent batching, turn loop, broadcasting, JSON saves | Yes |
| `apps/web` | Vite + TypeScript. Lobby, character creator, map view, chat log, combat HUD | Browser |

## Game loop

**Exploration.** Players move freely on the map (`move_intent`, validated by the engine against the `walls` layer) and speak in character (`say` with channel `ic`). The server batches in-character intents into a *beat*: the beat closes when every present player has acted or after a short window. The batch, plus a context pack (digest, facts, scene, party, recent turns), goes to the DM. The DM's JSON response is parsed with Zod, repaired at most once, then each action is validated and applied by the engine in order. Rejected actions are dropped and logged. Narration streams to clients.

**Checks.** `request_check` pauses the beat: the engine rolls (with tag bonus, advantage), broadcasts `roll_result`, and the result is fed back to the DM as an `[engine:]` line for the follow-up narration.

**Combat.** `start_combat` hands control to the engine: initiative, turn order, a turn timer, movement within speed, basic attacks, abilities and items. Enemies act through their behavior tags with simple heuristics. The DM narrates round summaries from engine events and may end combat with `end_combat`.

**Never game over.** A total party wipe becomes a consequence narrated by the DM.

## AI layer

- Every call goes through `ModelProvider` with a tier: `fast`, `standard`, `strong`. `high_stakes` routes the next DM call to `strong`.
- The Anthropic provider maps tiers to configurable model IDs (defaults: Haiku, Sonnet, Opus of the current family).
- The fake provider returns scripted, schema-valid responses. Tests and offline play use it; no test calls a real model.
- Prompts live in `packages/llm/prompts/*.md`.

## Content model (maps and sprites)

The DM can ask for any place or creature the story needs. It never draws tiles or pixels; it writes a structured *spec*, and deterministic engine code turns the spec into a valid, renderable component. The same spec later feeds the image model, so procedural placeholders and generated art share one contract.

**Maps: setting + layout + materials.**

- A map brief names an open-ended `setting` (any name: "sunken cathedral", "airship deck", "glacier rift") instead of choosing from five biomes. The setting picks one of a fixed set of **layout generators** (rooms and corridors, cave, open field, settlement, trail, arena, maze, islands), an environment (indoor, outdoor, underground), a mood, and a set of **materials** for each role: floor, path, wall, obstacle, liquid, hazard, decor props.
- **Materials** come from a data library in `packages/engine/data/materials.json` (each has a role, two colors from the palette, a pattern, walkability, sight blocking, tags and a `prompt_traits` line for the image model). The DM may also define a new material inline; the engine validates it, snaps its colors to the master palette and picks a pattern from the allowed list. A name the library does not know resolves by id, then tag, then role, so an unusual request never fails.
- Each generated map carries **its own inline tileset** built from the resolved materials, so the client can draw any map with no fixed catalog. The five old biomes become **setting presets** in data.
- Legibility rules (engine, tested): every resolved setting keeps a minimum luminance contrast between its wall and floor or path colors (`MIN_WALL_CONTRAST`), mood words in the setting name or tags (sunken, haunted, cursed, drowned) push the mood toward eerie, indoor maps use at most two floor materials, and secondary path materials form whole stretches rather than single tiles. `?mock=1&gallery=maps` renders every preset, layout and several free-text settings for visual QA.
- Reliability: the brief is schema-checked, materials resolve to a known role, the layout generator runs with a seed, and the map must pass the validation rules (3 seeds, then simplified rooms, then the preset's own layout, then a single plain chamber; it throws only if all of that fails).

**Sprites: body plan + parts + palette.**

- Every NPC, enemy, character and prop uses one `SpriteSpec`: a **body plan** (humanoid, beast, avian, serpent, insectoid, amorphous, construct, spirit, plant, object), a **size** (tiny to huge), a **palette** (primary, secondary, accent, detail colors snapped to the master palette), up to 6 **parts** from a catalog (horns, wings, tail, hood, robe, armor, shield, weapon kinds, crown, mask, glowing eyes, tentacles, spikes, aura, and so on), and a `traits` line for the image model.
- A **sprite designer** step turns a concept ("a robed chorister who borrows the voices of the drowned") into a spec: a fast-tier model call through `ModelProvider`, validated by schema, with a deterministic keyword designer as the offline fallback. The web client composes the spec procedurally on the 48 x 64 canvas.
- **Asset store:** specs (settings, materials, sprites) are cached by a hash of their concept, so recurring places and creatures reuse their look across a campaign. An `image_asset_id` slot on each spec is where generated art will plug in (M3).

## Decisions and MVP scope

1. **Spikes are not a gate.** The spike kit's fixtures and evals are reused as tests and eval scenarios, but `apps/web` and `apps/server` are built alongside them. (Diverges from the original phase plan.)
2. **Renderer:** Canvas 2D for placeholder shapes. Revisit a game framework when real art lands.
3. **Persistence:** in-memory rooms. Save states stay JSON files (`<data>/saves/<room>/<save>.json`), and accounts are JSON files too (`<data>/accounts/`), behind an `AccountStore` interface so a database can replace them later. `AEDM_DATA_DIR` sets the data folder (default `data/`); `AEDM_SAVE_DIR` still overrides the save folder.
4. **Accounts (optional):** guests still play with an anonymous display name and the per-room reconnect token, so friends can join in seconds. An account (username, password, display name) unlocks saved characters, a "My campaigns" list with resume, and ownership of saves.
   - *Passwords:* scrypt (N=16384, r=8, p=1, 16-byte salt, 64-byte key), stored as `scrypt$N$r$p$saltB64$hashB64`, compared in constant time. Unknown user and wrong password give the same `auth_error` and take the same time (a dummy hash is checked). Usernames are 3 to 20 characters of `[a-z0-9_-]`, case-insensitive and unique.
   - *Sessions:* a random 32-byte token (base64url) is returned once by `register`/`login`; only its sha256 is stored (`sessions.json`) with a 30-day expiry that slides on use. At most 10 sessions per user (oldest dropped). The browser keeps the token in localStorage and sends `resume_session` on every connect. `logout` deletes it.
   - *Limits:* 5 register/login attempts per connection per minute, and 5 failed logins per username per minute (then `rate_limited`, even for the right password until the window passes).
   - *Connection-level auth:* the login belongs to the WebSocket connection, so account messages work before joining a room. A logged-in player's seat carries `user_id`; reconnecting to a room they sit in rebinds them even without the room token.
   - *Characters:* `Character.user_id` stays the in-room player id (the engine, views and `owner_player_id` all key on it). The account link lives on the server-side player record and in save metadata (`player_user_ids`).
   - *Saved characters:* a template is the creator's `CharacterCreate` plus an id and, once used, the forged abilities (display only). Claiming one (`claim_character` with `character_id: "template"`) re-runs the normal forge path.
   - *Saves:* save files carry `owner_user_id` (the host's account at save time; null for guest rooms), `campaign_title`, and `room.player_user_ids`. `list_campaigns` scans the save folders for saves the account owns (latest autosave per campaign plus named saves). `resume_campaign` opens a new lobby; the host loads the save with `load_save`, and logged-in players get their own characters back by account. An account-owned save can only be loaded by its owner. Guest-hosted saves belong to nobody and appear in no list.
   - *Not built yet:* email and password reset, OAuth, per-IP rate limits, changing the password or display name, deleting an account.
5. **Open settings:** maps are described by an open-ended setting, a layout generator and materials (see Content model). Forest, dungeon, desert, town and interior survive only as setting presets.
6. **Level cap 10**, party size 2 to 6 (1 allowed in dev mode).
7. **Map generation is procedural and deterministic** from the DM's map brief and a seed; the model never emits tiles.
8. **Server turn loop** (`apps/server`): one serialized async queue per room runs DM turns, AI combat turns and timeouts; player actions that are plain engine calls (a move, an attack on your own turn) apply immediately and synchronously. DM actions are applied one at a time in order. `create_enemy` carries an optional `ref` (`en_` + snake_case) that the server registers the built archetype under, so a later `spawn_entity` and `start_combat` in the same response can name it. The server snaps a blocked spawn tile to the nearest free one and swaps archetype ids in `start_combat` for the spawned entity ids.
9. **Beats and combat narration:** a beat closes when every online player with a character has spoken in character, or 6 seconds after the first message. A check pauses the beat for exactly one follow-up DM call. In combat the DM narrates once per full round and again when the fight ends; a scene change (including an automatic move to a newly generated map) is a safe break and the engine's `rest` runs.
10. **Absence:** a player offline for more than 5 seconds is marked offline and their character is protected by the engine's `setAbsent`. If it becomes their combat turn and the turn timer runs out, the other players vote skip, wait or autopilot (majority decides).
11. **Level-up flow:** the owner chooses a score point, a new ability, a reforge or "keep my abilities" through `level_up_choice` (see contracts). Abilities are forged at the new level and must fit the power budget that is still free; a character may hold up to 6 abilities (`abilityLimits.maxAbilitiesPerCharacter`; creation still allows 1 to 3). Choices are refused during combat. The web client shows a "Level up!" badge and a modal, plus a read-only character sheet from the party card.

## Roadmap

- **M0 (this slice):** schemas, engine core (rules, cost, threat, mapgen), LLM layer with fake provider, server with lobbies and the exploration loop, web client with lobby, map, chat and shapes.
- **Content model (done):** schemas, contracts and prompts for `SpriteSpec`, materials, palette, map brief v2 (`setting`), map v2 (inline tileset) and asset records.
  - Map generator: `packages/engine/data/materials.json` (about 170 materials with aliases), `data/settings.json` (20 setting presets, keyword accents, layout fallbacks), eight layout generators in `packages/engine/src/map/layouts/`, inline tilesets, and a seed-then-fallback chain.
  - Sprite designer: `finalizeSpriteSpec` and `designSpriteOffline` (engine), `designSprite` (llm), and the server asset store in `apps/server/src/assets/` (cached per concept, 4 s timeout to the offline designer).
  - Web renderer: all 19 patterns with role treatments and mood, the sprite composer (10 body plans, 45 parts, poses), the creator sprite builder, and a QA gallery at `?mock=1&gallery=1`.
- **M0 level-up (done):** engine `levelUpView`, `spendScorePoint`, `addAbilityToCharacter`, `replaceAbility`, `skipAbilityPick`, `addGrowth`; server `level_up_choice`; web modal, character sheet and mock scenario. Known gaps: no undo or respec; the power budget is not re-validated when an ability's level caps change; abilities can only be reforged one at a time (one pick each); `/dev grow` is the only way to level without the DM awarding growth; enemies do not scale to the extra abilities.
- **M1:** full combat loop in the client, ability forge UI, enemy builder, saves and reload.
- **M2:** memory (summaries, retrieval), evals in CI, content safety pass, mobile polish.
- **M3:** image generation pipeline and acceptance gates from the style bible.
