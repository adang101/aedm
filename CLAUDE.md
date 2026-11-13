# AI Dungeon Master

A browser game where an LLM acts as Dungeon Master for 2 to 6 players on AI-generated 48-pixel tile maps. Solo project built with Claude Code. Read the docs before changing anything.

## Docs

- `docs/design.md`: architecture, data model, AI layer, roadmap, decisions. Its "Decisions and MVP scope" section is the source of truth for scope.
- `docs/rules-numbers.md`: every rules number and formula.
- `docs/contracts.md`: schemas for DM output, abilities, enemies, WebSocket messages and maps.
- `docs/spike-kit.md`: fixtures, eval scenarios and first-draft prompts.
- `docs/style-bible.md`: art spec and image prompt templates.

If a doc and the code disagree, ask which is right before changing either.

## Current phase

Milestone M0 (see `docs/design.md` roadmap). The spike kit's fixtures and evals are reused as tests, but are no longer a gate before `apps/web` and `apps/server`. The docs are guides, followed loosely; `docs/design.md` records deliberate divergences.

## Rules for working in this repo

1. The engine is pure and deterministic. `packages/engine` has no I/O, no `Date` and no `Math.random`. Randomness comes from a seeded RNG that is passed in.
2. Never trust LLM output. Parse it with a Zod schema from `packages/schemas`, validate it semantically in the engine, and allow at most one repair call. The model proposes and the engine decides.
3. The LLM never changes HP, stats, dice results or inventory. Only engine code does.
4. Rules numbers live in `packages/engine/data/*.json`, never in code. Change numbers in data, not logic.
5. Ability cost math is integer math (hundredths). Never use floating point for costs. `fixtures/ability-costs.json` must pass.
6. Write the failing test first for the engine, validators, and the cost and threat functions.
7. Schemas first: update `docs/contracts.md` and `packages/schemas` before any feature that uses a contract. Bump `v` when a schema changes shape.
8. Prompts live in `packages/llm/prompts/` as separate files. Changing a prompt means running `evals/`.
9. Every model call goes through the `ModelProvider` interface. No direct SDK calls elsewhere. Tests use the fake LLM server, never a real model.
10. Never commit secrets. Use `.env` (see `.env.example`) and never print API keys.
11. Do not name other games, franchises, real people or artists in image prompts, product text or marketing. Use trait descriptions only.
12. Keep the SRD 5.2 attribution statement in `NOTICE.md`.

## Commands

Update these as the scripts are added.

- `pnpm install`
- `pnpm test` (unit and contract tests)
- `pnpm typecheck`
- `pnpm lint`
- `pnpm eval` (LLM evals, which cost money; run only when asked). Needs a real provider (`AEDM_LLM_PROVIDER` with its key, read from the environment or `.env`) and refuses the fake one unless `--allow-fake`. Flags: `pnpm eval -- --only E06,E21 --runs 3 --suite dm|forge|all --delay-ms 500`. Writes `packages/evals/reports/<timestamp>.json`; exits non-zero when a scenario is below its pass bar. See `packages/evals/README.md`.
- `pnpm dev:server` (game server, defaults to the fake offline DM; set `AEDM_LLM_PROVIDER=gemini` with `GEMINI_API_KEY`, or `anthropic` with `ANTHROPIC_API_KEY`, for a real model)
- `pnpm dev:web` (Vite client)
- `pnpm dev:edge` (builds the client, then runs the Cloudflare Worker and Durable Object locally with `wrangler dev`)
- `pnpm deploy:edge` (builds the client and deploys to Cloudflare; see `apps/edge/README.md`)

## Conventions

- TypeScript in strict mode. Small modules and pure functions.
- Tiles are 48 x 48 pixels, characters 48 x 64. Coordinates are in tiles, not pixels.
- Ask before adding a dependency, and say why it is needed.
- Ask before changing a number in `docs/rules-numbers.md`; simulations tune those.

## Definition of done

Tests added or updated, typecheck and lint pass, schema changes versioned, and the docs updated if behavior changed.
