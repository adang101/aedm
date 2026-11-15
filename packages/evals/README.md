# @aedm/evals

LLM evals for the DM, the ability forge and the story bible. They call a real model and cost money, so they never run in `pnpm test`.

```
pnpm eval -- --only E06,E21 --runs 3 --suite dm|forge|bible|all --delay-ms 500
```

- Needs `AEDM_LLM_PROVIDER` (`gemini` or `anthropic`) and its key, from the environment or `.env`. The fake provider is refused unless `--allow-fake` (for smoke-testing the harness).
- Runs are sequential, `--runs` per scenario (default 5), with a pause between model calls.
- Prints a table (passes, bar, first failure) and writes `reports/<timestamp>.json` (git-ignored). Exits non-zero when any scenario is below its bar: 100% for injection, leak, consistency, caps, format and safety; 80% for memory, continuity, combat, forge, brevity, direction, milestones, plan use and the bible.

A DM scenario builds a `GameState` with the engine's testkit, turns it into a context pack with the server's `buildContextPack`, runs `runDmTurn`, then applies the parsed actions with `applyDmActions`. Its pure `check` sees what the model proposed and what the engine accepted or refused. Forge scenarios call the server's `forgeCharacterAbilities`. Bible scenarios make the one bible call and judge the reply as it came. All checks are code, with no judge model, so the language checks (E15, E17, E18) are heuristics.

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
| E27 to E30 | Combat presence: questioning a surrendered enemy, a taunting bloodied boss, a creative stunt, a truce (combat-safe actions only, narration within 55 words, no invented damage) |
| E31 to E34 | Campaign plan at play time: an ordinary beat stays under 80 words, a stuck party is pointed toward the next objective without the hint being read out, the DM leaves engine-tracked milestones to the engine, and a planned NPC answers instead of a new one being invented |
| F01 to F15 | The spike kit's fifteen abilities |
| F16 to F18 | Campaign adaptation, party overlap, budget fit |
| B01, B02 | Story bible: the first reply (no repair call) is a schema-valid bible whose campaign plan passes the engine's `validateCampaign`, with a hint on every milestone, 3 or more cast, 3 or more fights across 3 or more stages, a key item and varied places. B01 has a plot plan, B02 lets the model choose |

Approximations: E12 builds the named enemies with the real enemy builder (only those given a `ref`) and checks the threat on the map after the engine's own budget check. E19 plants the fact in the oldest summary tier (`storySoFar`) rather than a 60-turn log. The forge's "first try" bar is not measured, because the forge hides its repair call.

Harness tests (`*.test.ts`) use the fake provider only.
