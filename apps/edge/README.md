# apps/edge: Cloudflare Worker and Durable Object

Hosts the whole game: static client, WebSocket endpoint and storage. The Node server (`pnpm dev:server`) stays the local-dev path; both run the same `createGameCore`.

## Run locally

```
pnpm dev:edge        # http://localhost:8787 (wrangler picks a port; the client uses same-origin /ws)
```

Local state lives in `apps/edge/.wrangler/state`. Delete that folder to reset accounts and saves.

## Deploy (free plan, `*.workers.dev` URL)

1. Create a free Cloudflare account.
2. `pnpm --filter @aedm/edge exec wrangler login`
3. `pnpm deploy:edge`. The first deploy prints your `https://aedm.<subdomain>.workers.dev` URL.
4. For a real model, set the secret and switch the provider:
   - `pnpm --filter @aedm/edge exec wrangler secret put ANTHROPIC_API_KEY`
   - change `AEDM_LLM_PROVIDER` to `anthropic` in `wrangler.jsonc` and deploy again.

Without step 4 the game uses the scripted offline DM.

## Custom domain later

Buy the domain in the Cloudflare dashboard, then add to `wrangler.jsonc`:

```
"routes": [{ "pattern": "yourdomain.com", "custom_domain": true }]
```

and deploy. Cloudflare creates the DNS record and certificate.

## Notes

- One Durable Object (`GameHub`) holds every room. Autosaves in its storage survive eviction.
- Free plan limits to watch: CPU per request (scrypt login, big map generation) and the daily Durable Object duration while sockets are open.
