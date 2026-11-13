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
- **What the DM sees each turn (token budget).** The system prompt (rules plus action catalog, with the sorted material id list) is fully static so provider prefix caches hit. The user message is not cached and is kept small:
  - Empty sections are omitted (no "(none)" blocks). Tags the system prompt names: `<campaign>`, `<summaries>`, `<canonical_facts>`, `<scene>`, `<party>`, `<quests>`, `<milestones>`, `<pacing>`, `<recent_turns>`, `<engine_results>`, `<cast>`, `<limits>`, `<player_input>`. The only prose kept is a one-line untrusted-input notice before `<player_input>`.
  - Facts: at most 20 and about 2,400 characters (`CONTEXT_LIMITS`). Facts about something in the scene, the party or the current map, and all `is_alive` facts, come first, then the newest; output stays chronological with a "N other facts not shown" line.
  - Party lines carry id, name, title, level, hp, tags and ability names only when present, items, and `(away)` for absent players. No player names.
  - Entities read `id "name" kind @x,y`, with hp only when wounded and no coordinates for objects.
  - Milestones: open ones of the current and next stage, plus a count of completed and of later ones. Quests: active ones in full, closed ones as one line of titles.
  - Recent turns: player lines verbatim (escaped, untrusted); DM turns except the latest are cut to 40 words. The window stays at 12 turns.
  - Pacing is two lines.
  - A repair call for a DM reply sends only the system prompt, the bad reply and the errors (`repairContext: "minimal"`), never the full context. Other repairs (forge, enemy, bible) still resend their small requests because their checks are semantic.
  - Output caps per purpose live in `MAX_OUTPUT_TOKENS` (`packages/llm/src/provider.ts`), sized to the largest valid reply plus room for hidden thinking tokens.

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

## Player-made sprites (built: Describe, Paint over, Paint from scratch, Workshop and campaign cast)

Players can make the look of their own character, and of NPCs and enemies they offer to a campaign, in three ways. Every way ends in the same sprite recipe, so the renderer, the DM and the asset store treat all of them alike.

| Way | What the player does | Result |
| --- | --- | --- |
| Describe | Writes up to 300 characters ("a lanky heron-folk ferryman with a lantern and a patched blue coat") and picks a role | The sprite designer (the same pipeline the DM uses: fast-tier model, offline keyword fallback, engine finalizer) returns a `SpriteSpec`. The player can regenerate (a new seed), then fine-tune it in the parts builder. |
| Paint over | Opens any spec sprite in the pixel editor | The composed front idle frame is rasterized to a 48 x 64 grid and becomes editable. Saving keeps the original spec as `base` (for traits, fallbacks and the image model). |
| Paint from scratch | Opens a blank 48 x 64 canvas | A pixel sprite with no base spec. |

**Built (Describe path).** The creator's "Describe your look" box sends `design_sprite` (prompt up to 300 characters, `role_hint`, optional `seed` and `name`); the server answers `sprite_designed` (`spec`, `notes`, `source` of `model` or `offline`), correlated by the envelope id. Divergences from the plan: the result is never cached in the asset store (a re-roll must differ, so the designer runs fresh each time, with the usual 4 s timeout and offline fallback), and the offline look varies with the seed while a real model simply answers again. Calls are limited to 6 per minute per account (per connection for guests), set in `DEFAULT_CONFIG.limits.spriteDesign`. In the builder, an untouched design is kept whole (any size, up to six parts, traits and pose); touching a control builds on top of it with at most four parts. `?mock=1` answers with the offline designer. WS_VERSION is 5 (see the pixel sprite note below).

**Built (Paint over, Paint from scratch).** The creator's "Paint your own" row opens the pixel editor as a modal: "Paint over" rasterizes the current look (composed front idle frame at medium scale, feet on y = 60, colors snapped to the master palette) and "Paint from scratch" opens a blank canvas; "Edit painting" reopens a saved one. Saving puts the `pixel` recipe in the creator (preview, claim); changing the builder, designing again or randomizing replaces the painting, and "Remove painting" returns to the builder's spec. The editor's pure logic is `apps/web/src/state/pixel-editor.ts`; the DOM is `apps/web/src/ui/pixel-editor.ts`. Validation is live and Save stays disabled until it passes; feet off the guide by more than 4 rows are shifted automatically. Divergences: the editor keeps master palette ids and builds the recipe palette from the colors in use (so the 32-color limit is counted on distinct colors used), L and R select line and rectangle and a toggle picks filled or outline rectangles, recent colors are kept per editor session only, and the painted `size` is the builder's size at the time. The server validates on `claim_character` and answers `invalid_sprite`. The renderer draws `pixel` recipes without the spec outline pass (the painter owns the outline) and with no pose shaping.

**Pixel sprite.** A new recipe kind, `pixel`: 48 x 64 pixels, a palette of at most 32 colors drawn from the master palette plus the outline color, and pixels stored as palette indices (0 is transparent) in a run-length encoded string. Alpha is therefore only 0 or 255, as the style bible requires. Facing left mirrors the image; the idle bob, shadow, HP bar and rings are added by the renderer as for spec sprites. Large and huge sizes scale it with nearest-neighbor. The encoded sprite must fit in a client message (8 KB).

**Validation (engine, pure).** Exact size; every index inside the palette; every palette color on the master palette; at least 60 opaque pixels; no opaque pixel within 2 pixels of the canvas edge (style bible margins); feet within 4 pixels of y = 60 (auto-shifted if not). Failing sprites are rejected with the reason shown in the editor's "Check" panel before saving.

**Pixel editor (web).** Pencil, eraser, bucket fill, eyedropper, line and rectangle, a mirror-symmetry toggle (useful for front-facing chibis), undo and redo (50 steps), grid zoom from 4x to 12x, the master palette grouped by ramp with recent colors, an onion-skin of the base spec when painting over, and a live preview at 1x, on a floor tile and in both facings. Works with mouse, touch and pen. Keyboard shortcuts: B pencil, E eraser, G fill, I eyedropper, M mirror, Ctrl+Z and Ctrl+Y.

**Built (Workshop and campaign cast, WS v6).** Accounts get a Workshop (`<data>/accounts/workshop/<user>.json`, one file per account, atomic writes) with the limits below; contracts are in `contracts.md`. The web client has a Workshop modal (home account bar, lobby cast panel, creator): design a look for a pc, NPC, enemy or prop through `design_sprite` with a role picker, save, edit details, "Edit painting" in the pixel editor (a spec asset gets "Paint a copy"), and delete. The creator's "Save look to Workshop" keeps the current look, designed or painted. The lobby shows a cast panel: the host's `custom_cast` and `custom_paintings` settings, entries with Approve, Deny, Remove (host) and Withdraw (owner), an offer list from the viewer's Workshop, and per-viewer hide switches. Hide switches (one per entry, plus "hide all painted sprites") are stored in `localStorage` only and swap the sprite for a neutral shape in the renderer. Divergences: only `npc` and `enemy` looks can be offered (pc and prop assets stay in the Workshop), the cast is not saved with the campaign, the host and owner controls exist in the lobby only (the server accepts them in game), the host may change only the two cast settings once play has started, a cast entry is a snapshot (later Workshop edits do not change it), and `?mock=1` has a Workshop and cast too (`__mock.simulateOffer()` adds a pending offer from a fake player). Prompt change (`dm-system.md` now explains `asset_ref`): the evals were not run.

**Design notes (original plan).**

- Each account has a **Workshop**: a library of its own sprite assets, each with a name, role hint (pc, npc, enemy, prop), a short concept, the recipe and its source (designed, painted over, painted).
- A player can offer a Workshop asset to the current campaign's **cast**. Room setting `custom_cast`: off, host approval (default) or open.
- The DM's context lists the approved cast (name, role hint, concept) and may use an entry with `create_npc` or `create_enemy` by setting `asset_ref`. Looks and concept come from the player; the enemy builder and engine still decide every number, exactly as for DM-invented creatures.
- A character's own sprite can be any recipe kind, including a pixel sprite.

**Safety.** Painted images can contain anything, so: the host can turn custom paintings off for the room, anyone can hide a custom sprite for themselves, the host can remove one from the campaign, and painted sprites are only visible inside rooms the owner plays in. The automated image gates from the style bible (including the classifier) apply when the image pipeline lands (M3). Prompts follow the same rule as all text: no names of real people, other games or franchises; the finalizer strips them from traits.

**Limits.** 200 Workshop assets and 5 MB per account; sprite design calls are rate limited per account (they cost money once a real model is attached).

## Story structure

Every campaign follows one of seven classic **plot patterns** and one of six **emotional arcs**. The pattern decides *what kind* of story it is and its stages; the arc decides whether the party's fortunes trend up or down between them. Both guide pacing; player choices still win, and the DM re-aligns the plan rather than railroading.

**Plot patterns** (stages in order):

| Id | Shape | Stages |
| --- | --- | --- |
| `overcoming_the_monster` | A threat grows until the heroes confront and destroy it | call, early success, frustration, nightmare, final confrontation |
| `rags_to_riches` | The humble rise, lose everything, and earn it back for real | humble start, early rise, central crisis, independence, final union |
| `the_quest` | A long journey toward a goal through trials and temptations | call, journey, arrival and frustration, final ordeals, goal |
| `voyage_and_return` | Into a strange world, then a hard escape home, changed | fall into the strange, fascination, frustration, nightmare, escape and return |
| `comedy` | Confusion and misunderstandings pile up, then untangle | order disturbed, confusion, peak of muddle, revelation, reconciliation |
| `tragedy` | Ambition or a flaw leads to ruin (softened to loss at "family") | anticipation, dream, frustration, nightmare, downfall |
| `rebirth` | A dark spell or flaw holds sway until redemption breaks it | shadow falls, apparent calm, tightening grip, darkest hour, awakening |

**Emotional arcs** (fortune curve across the campaign; player-facing names are descriptive):

| Id | Shown as | Curve |
| --- | --- | --- |
| `rise` | Steady climb | up |
| `fall` | Long descent | down |
| `fall_rise` | Into the pit and out | down then up |
| `rise_fall` | Soaring, then falling | up then down |
| `rise_fall_rise` | Rise, fall, rise again | up, down, up |
| `fall_rise_fall` | Hope between two falls | down, up, down |

**Data.** `packages/engine/data/plots.json` holds, for each pattern, its stages (id, purpose, tension target 0 to 10, a suggested encounter difficulty, typical scene kinds and milestone templates), and for each arc a fortune curve sampled per stage. Recommended pairings are listed per pattern (for example `tragedy` with `rise_fall`), but any pairing is allowed.

**Flow.**

1. In the lobby the host picks a pattern and an arc, or leaves either on "Auto". Auto picks deterministically from the pitch keywords and the seed.
2. The story bible prompt receives the stage list and the fortune curve. The bible gains `plot: { pattern, arc, stages: [{ id, title, goal }] }` and every milestone carries a `stage` id. The engine validates that every stage has at least one milestone, in stage order.
3. During play the context pack adds a pacing block: current stage and its purpose, tension target, fortune trend ("this stretch should leave the party worse off"), and the suggested difficulty. The current stage is the stage of the first incomplete milestone; completing the last milestone of a stage advances it.
4. Suggested difficulty only sets the default for encounters; the engine's threat budgets still apply.
5. If the party abandons the planned path, the DM may re-plan the remaining stages with an `adjust_plot` action (new stage goals and milestones for stages not yet started; completed milestones never change).

**Built.** `plots.json` holds each stage's id, name, purpose, tension target and suggested difficulty, each arc's fortune per stage, and per pattern keywords and recommended arcs; scene kinds and milestone templates are not in the data yet. Engine: `pickPlot`, `plotOutline`, `validateBiblePlot`, `currentStage`, `pacingBlock`, and `adjust_plot` and stage-order checks in `applyDmActions`. The server resolves the room settings before bible generation and the bible prompt receives a `<plot_plan>`. Divergences from the plan above: the lobby option is called "Auto" (setting value `auto`); the engine also rejects `complete_milestone` for a stage later than the current one, so stages complete in order.

**Evals (not yet written).** New scenarios should check that the DM respects the current stage and fortune trend (rated), never completes a milestone out of stage order, and keeps "tragedy" within the content rating.

## Capability check (as of this branch)

| Request | Today | Gap |
| --- | --- | --- |
| Players create their own sprite from a prompt | Yes: the creator has a parts builder and a "Describe your look" prompt (`design_sprite` / `sprite_designed`) with live preview, re-roll (a new seed) and builder tweaks. The server still designs a look from title and description when no sprite is sent | Generated art (M3) |
| Players create enemy and NPC sprites | Yes: the Workshop's "Design a look" has a role picker (npc, enemy, prop, pc); NPC and enemy looks are offered to the campaign cast and the DM uses them through `asset_ref` | Generated art (M3) |
| Paint over an existing sprite | Yes: "Paint over" in the creator rasterizes the current look into the pixel editor; the result is the character's `pixel` recipe with the spec kept as `base` | Generated art (M3) |
| Paint from scratch | Yes: the same editor with a blank canvas and a feet guide | Generated art (M3) |
| Stories follow classic plots and emotional arcs | Yes: `plots.json`, bible `plot` field, milestone stages, pacing block in the DM context, `adjust_plot`, lobby selects | Eval scenarios for stage and fortune adherence (below), scene kinds and milestone templates in `plots.json` |

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
12. **Hosting on Cloudflare (`apps/edge`):** one Worker serves the Vite build as static assets and upgrades `/ws` into a single `GameHub` Durable Object (SQLite-backed, so the free plan works). The hub runs the same `createGameCore` as the Node server, so every room, timer and invite code lives in one object; sharding by room is the next step if one object is ever too small. Storage sits behind `KvBackend` (`apps/server/src/kv.ts`): `FsKv` for Node, `DoKv` (chunked values) for the Durable Object. Saves, accounts, the Workshop and assets all use it, so the two hosts differ only in the backend. WebSockets are accepted without hibernation because rooms hold live timers and in-memory state; autosaves are what survive the object being evicted. Prompt files are bundled as text and registered with `registerPrompts`. Open risk: scrypt (about 50 ms of CPU) may exceed the free plan's CPU limit per request; it worked under `wrangler dev`, so test it on a deployed Worker before relying on the free plan.
13. **Model providers:** `fake` (default), `anthropic` and `gemini` sit behind `ModelProvider`; `createProviderFromEnv` picks one from `AEDM_LLM_PROVIDER` for both the Node server and the Worker. The Gemini provider uses plain `fetch` with SSE streaming (no SDK), the key in a header only, and per-tier model names that can be overridden because Google retires preview names. Gemini 3 models run with a low thinking level by default (`AEDM_GEMINI_THINKING`), because thinking tokens count against the output limit. Free Gemini limits are small and change; rate limits surface as retryable `rate_limit` errors. Free-model output validates less often, so more turns go through the one repair call.
14. **Token diet for the DM call:** the per-turn context is bounded and prioritised instead of dumping all state (see AI layer), the DM repair call omits the context, and each purpose has an output cap. Reason: input tokens grow with the campaign and the system prompt is paid on every call; the DM keeps what it needs to stay consistent (nearby facts, open goals, the latest narration in full). Prompts changed, so run `pnpm eval` before a release.

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
- **Next (designed, not built):** generated art for player-made sprites (M3). Player-made sprites (Describe, Paint over, Paint from scratch, Workshop, campaign cast) and story structure are built. See the sections above.
