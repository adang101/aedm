# apps/edge: Cloudflare Worker and Durable Object

Hosts the whole game: static client, WebSocket endpoint and storage. The Node server (`pnpm dev:server`) stays the local-dev path; both run the same `createGameCore`.

## Run locally

```
pnpm dev:edge        # http://localhost:8787 (wrangler picks a port; the client uses same-origin /ws)
```

Wrangler reads `apps/edge/.dev.vars` and it overrides `vars` in `wrangler.jsonc`. `wrangler.jsonc` sets the provider to `gemini`, so copy the example first or every connection fails:

```
cp apps/edge/.dev.vars.example apps/edge/.dev.vars
```

The example uses the scripted offline DM (`AEDM_LLM_PROVIDER=fake`). To try a real model locally, set `AEDM_LLM_PROVIDER=gemini` and `GEMINI_API_KEY` in `.dev.vars`.

Local state lives in `apps/edge/.wrangler/state`. Delete that folder to reset accounts and saves.

## Deploy (free plan, `*.workers.dev` URL)

1. Create a free Cloudflare account.
2. `pnpm --filter @aedm/edge exec wrangler login`
3. `pnpm deploy:edge`. The first deploy prints your `https://aedm.<subdomain>.workers.dev` URL.
4. Store the Gemini key as a secret: `pnpm --filter @aedm/edge exec wrangler secret put GEMINI_API_KEY`. `wrangler.jsonc` already sets `AEDM_LLM_PROVIDER` to `gemini`.

Without the secret, connections fail with "The game server is misconfigured." Set `AEDM_LLM_PROVIDER` to `fake` for the scripted offline DM. Never put a key in `wrangler.jsonc` or the repo.

Optional plain variables in `wrangler.jsonc` `vars`:

- Gemini model names change often. Override a tier with `AEDM_GEMINI_MODEL_FAST`, `AEDM_GEMINI_MODEL_STANDARD` and `AEDM_GEMINI_MODEL_STRONG`.
- `AEDM_GEMINI_THINKING` sets the thinking level of Gemini 3 models: `minimal`, `low` (default), `medium`, `high`, or `off` for the model default. Thinking tokens count against the output limit, so higher levels can leave too little room for the answer.
- For Anthropic instead, set the `ANTHROPIC_API_KEY` secret and `AEDM_LLM_PROVIDER` to `anthropic`.

## Custom domain later

Buy the domain in the Cloudflare dashboard, then add to `wrangler.jsonc`:

```
"routes": [{ "pattern": "yourdomain.com", "custom_domain": true }]
```

and deploy. Cloudflare creates the DNS record and certificate.

## Notes

- One Durable Object (`GameHub`) holds every room. Autosaves in its storage survive eviction.
- Free plan limits to watch: CPU per request (scrypt login, big map generation) and the daily Durable Object duration while sockets are open.
