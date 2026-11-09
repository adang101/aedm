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

## Assets

For now every map tile, character and enemy is drawn procedurally as blocks and shapes from a placeholder tileset (`ts_blocks`) and sprite recipes (shape, color, glyph). The asset catalog interface is kept so an image model can fill it later (see `style-bible.md`).

## Decisions and MVP scope

1. **Spikes are not a gate.** The spike kit's fixtures and evals are reused as tests and eval scenarios, but `apps/web` and `apps/server` are built alongside them. (Diverges from the original phase plan.)
2. **Renderer:** Canvas 2D for placeholder shapes. Revisit a game framework when real art lands.
3. **Persistence:** in-memory rooms with JSON-file saves on the server. A database comes later.
4. **Auth:** anonymous display names plus a per-browser token. Accounts come later.
5. **Biomes:** forest, dungeon, desert, town, interior.
6. **Level cap 10**, party size 2 to 6 (1 allowed in dev mode).
7. **Map generation is procedural and deterministic** from the DM's map brief and a seed; the model never emits tiles.

## Roadmap

- **M0 (this slice):** schemas, engine core (rules, cost, threat, mapgen), LLM layer with fake provider, server with lobbies and the exploration loop, web client with lobby, map, chat and shapes.
- **M1:** full combat loop in the client, ability forge UI, enemy builder, saves and reload.
- **M2:** memory (summaries, retrieval), evals in CI, content safety pass, mobile polish.
- **M3:** image generation pipeline and acceptance gates from the style bible.
