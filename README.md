# aedm

Autonomous Enhanced Dungeon Master: host a lobby, invite 2 to 6 friends, and play a tabletop-style fantasy campaign where an LLM runs the story and a deterministic rules engine owns every number.

See `docs/design.md` for the architecture and `CLAUDE.md` for working rules.

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm lint
cp .env.example .env    # optional: set AEDM_LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY
pnpm dev:server         # ws://localhost:8787
pnpm dev:web            # http://localhost:5173
```
