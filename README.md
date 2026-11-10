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

## Play locally

1. Start the server and the web app in two terminals: `pnpm dev:server` and `pnpm dev:web`.
2. Open the web URL (printed by Vite, usually http://localhost:5173) in two browser windows, or one normal and one private window, so each has its own player.
3. Window A: enter a name and press **Host a game**. Copy the invite code (or the share link).
4. Window B: enter a name, paste the code, and press **Join**.
5. Each player picks a premade character (Brindle, Tamsin, Orrin) or builds one, then presses **Claim this character** and **Ready**. The ability forge turns each ability description into rules and prices it; what it changed is shown in the story log.
6. The host presses **Start game** (or turns on dev solo mode to start alone). Type what your character does or says. In-character messages (IC) go to the DM; switch to OOC for table chat the DM never sees. The DM answers once everyone present has acted, or a few seconds after the first action.
7. Try "I attack the robed figure" to start a fight. In combat only the player whose turn it is can act; enemies and absent players' characters are played by the engine.

### The DM: fake or real

- **Fake DM (default).** `AEDM_LLM_PROVIDER=fake` needs no key. It is an offline improv narrator, forge and enemy builder: deterministic, schema-valid, and good enough to exercise every rule and screen, but its prose is canned.
- **Real model.** Copy `.env.example` to `.env`, set `AEDM_LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, and restart the server. The key is read from the environment and never logged. This costs money per turn.

### Leveling up (and testing it)

The DM awards growth through milestones and contextual awards; 100 growth is a level. When a character levels, a **Level up!** badge appears on its party card and over the map: pick a +1 ability score (levels 3, 6, 9), learn a new ability (forged within the free power budget), reforge one, or keep your abilities. Click your party card for the character sheet. Level-up choices are only accepted outside combat.

**Dev only:** in a room with *dev solo mode* on, typing `/dev grow 100` in OOC chat grants growth to your character through the engine (so you can reach a level-up without playing for it). With dev solo off the command does nothing. Never enable dev solo on a shared server.

Accounts are optional. Guests play as before. **Create account** on the home screen (or **Log in**) keeps your characters and campaigns: tick **Save to my characters** in the creator, press **Save** in a game, and later pick **Resume** under **My campaigns**, wait for friends in the lobby and press **Load campaign**. Accounts and sessions are JSON files in `data/accounts/`; passwords are stored only as scrypt hashes.

Other server settings: `AEDM_PORT` (default 8787), `AEDM_DATA_DIR` (default `data/`; holds `saves/` and `accounts/`), `AEDM_SAVE_DIR` (default `<data>/saves`; each room autosaves to `<room>/autosave.json` after every DM turn, and `request_save` writes named saves), `AEDM_DEV_LOG=1` (log DM actions the engine rejected). If the server runs on another host, build the web app with `VITE_AEDM_WS_URL=ws://host:8787`.
