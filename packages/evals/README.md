# @aedm/evals

LLM evals for the DM and the ability forge. They call a real model and cost money, so they never run in `pnpm test`.

```
pnpm eval -- --only E06,E21 --runs 3 --suite dm|forge|all --delay-ms 500
```

- Needs `AEDM_LLM_PROVIDER` (`gemini` or `anthropic`) and its key, from the environment or `.env`. The fake provider is refused unless `--allow-fake` (for smoke-testing the harness).
- Runs are sequential, `--runs` per scenario (default 5), with a pause between model calls.
- Provider outages (rate limits, network errors, 5xx) are retried after 15 s and 45 s. A run still lost after that counts as no data, never as a failure, and after three such runs in a row the rest are skipped. A scenario with no judged runs shows `N/A`; the exit code is 3 when nothing failed but some scenarios have no data. Free model tiers have small daily quotas, so run with `--only` or `--runs 1`, or point a tier at a model with quota left (`AEDM_GEMINI_MODEL_STANDARD=...`).
- Prints a table (passes, bar, first failure) and writes `reports/<timestamp>.json` (git-ignored). Exits non-zero when any scenario is below its bar: 100% for injection, leak, consistency, caps, format and safety; 80% for memory, continuity, combat and forge.

A DM scenario builds a `GameState` with the engine's testkit, turns it into a context pack with the server's `buildContextPack`, runs `runDmTurn`, then applies the parsed actions with `applyDmActions`. Its pure `check` sees what the model proposed and what the engine accepted or refused. Forge scenarios call the server's `forgeCharacterAbilities`. All checks are code, with no judge model, so the language checks (E15, E17, E18) are heuristics.

Hard caps (E10, E13) judge the model's proposals, not the engine's refusals. E25 counts only accepted `open_thread` actions and reports proposals as a note.

## Scenarios

| Ids | What |
| --- | --- |
| E01 to E05 | Injection and prompt or notebook leaks |
| E06 to E09 | Consistency with facts, inventory and position |
| E10 to E13 | Caps: loot, check DC and tags, enemy threat, session growth |
| E14 to E18 | Format and safety |
| E19, E20 | Memory: a planted fact, a summary against a canonical fact |
| E21 to E26 | Notebook secret, NPC promise, dead NPC in the dossier, thread payoff, thread cap, stage order |
| E27 to E30 | Combat presence: questioning a surrendered enemy, a taunting bloodied boss, a creative stunt, a truce (combat-safe actions only, 60-word narration, no invented damage) |
| F01 to F15 | The spike kit's fifteen abilities |
| F16 to F18 | Campaign adaptation, party overlap, budget fit |

Approximations: E12 builds the named enemies with the real enemy builder (only those given a `ref`) and checks the threat on the map after the engine's own budget check. E19 plants the fact in the oldest summary tier (`storySoFar`) rather than a 60-turn log. The forge's "first try" bar is not measured, because the forge hides its repair call.

Harness tests (`*.test.ts`) use the fake provider only.
