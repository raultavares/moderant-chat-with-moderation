# Try moderant with a test game

Once `terraform apply` has placed the chat infrastructure on your account, you can exercise it end-to-end with a small self-hosted "test game" Worker that mints JWTs, serves a browser page, and connects to the chat over WebSocket. This is the fastest way to see strikes, mutes, watch mode, and the admin dashboard working together before you wire moderant into your real backend.

The test game is **not shipped in this repo** on purpose. Each account's test game has its own hostname, its own Access application AUD, its own KV namespaces, and its own copy of the signing key. Putting any of that in version control would couple the repo to a specific account. Instead, this document walks you through the ~15 minutes it takes to stand one up.

## What you build

A single Cloudflare Worker (`moderant-testgame`) that:

- Serves an HTML page with a username picker, a match list, and a chat panel
- Is protected by a Cloudflare Access application (so only your team can use it)
- Mints a short-lived RS256 JWT for the signed-in player on every page load
- Includes the moderant JavaScript SDK as a bundled IIFE
- Opens a WebSocket to `wss://<your chat_hostname>/rooms/<matchId>/ws`
- Renders chat messages, blocked notices, rate-limit notices, strike pills, watch pills, and a live mute countdown

It is intentionally small. The whole thing is one `index.ts`, one `wrangler.jsonc`, two KV namespaces, and one secret.

## Prerequisites

- You have run `terraform apply` from [DEPLOY.md](./DEPLOY.md) and the handoff block is visible via `terraform output handoff`.
- The test game is listed in `issuers` in your `terraform.tfvars` (for example `"testgame" = {}`), and you know its values from the handoff block: `chat_hostname`, the game's `iss` and `kid`, and the path to its RS256 private key under `./keys/`. Giving the test game its own entry keeps its test players' strikes separate from your real game's.
- You can create a Cloudflare Access application on the same account and copy its AUD tag.
- `wrangler` installed locally (`pnpm add -g wrangler` or use `pnpm dlx wrangler`).

## 1. Pick a hostname and create the Access application

Decide on a hostname for the test page, for example `game.chat.yourgame.com` (any subdomain of the same zone the chat lives on works; a sibling of `chat_hostname` is tidy).

In the dashboard: **Zero Trust → Access → Applications → Add an application → Self-hosted**.

- Application domain: the hostname you just picked.
- Session duration: whatever your team uses.
- Policy: `Allow` with the identity rules that match your team (email ending in your corporate domain, specific users, Access group, etc.).

After creating the application, open its **Overview** tab and copy the **Application Audience (AUD) Tag**. It is a 64-character hex string. You will paste it into the Worker config below.

Also note your Access **team domain**: in Zero Trust → Settings → Custom pages → Team domain. It looks like `yourteam.cloudflareaccess.com`.

## 2. Scaffold the Worker

Create a directory outside this repo (or in `examples/` which is gitignored). The example commands below use `examples/testgame`; everything under `examples/` is in `.gitignore`.

```sh
mkdir -p examples/testgame/src/sdk
cd examples/testgame
pnpm init
pnpm add -D wrangler typescript @types/node
pnpm add jose
```

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "moderant-testgame",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    { "pattern": "game.chat.yourgame.com", "custom_domain": true }
  ],
  "rules": [
    { "type": "Text", "globs": ["**/*.iife.js"], "fallthrough": true }
  ],
  "observability": { "enabled": true },
  "vars": {
    "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com",
    "ACCESS_AUD": "paste-the-64-char-aud-from-step-1",
    "THE_GAME_ISSUER": "<the test game's key in issuers, e.g. testgame>",
    "THE_GAME_KID": "<its kid from terraform output issuers>",
    "CHAT_AUDIENCE": "moderant-chat",
    "CHAT_WS_BASE": "wss://chat.yourgame.com"
  },
  "kv_namespaces": [
    { "binding": "MATCHES", "id": "to-fill-in-step-3" },
    { "binding": "USERNAMES", "id": "to-fill-in-step-3" }
  ]
}
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "sync-sdk": "cd ../../packages/web && pnpm run build:iife && cp dist-iife/index.global.js ../../examples/testgame/src/sdk/moderant-web.iife.js",
    "predev": "pnpm run sync-sdk",
    "predeploy": "pnpm run sync-sdk",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
```

The `sync-sdk` script is important. It rebuilds the moderant web SDK from source and copies the IIFE into `src/sdk/moderant-web.iife.js`, which the Worker imports as a text asset. Without the `predeploy` hook, a stale SDK bundle can ship and silently drop the newer event types (`standing`, `muted`, etc.).

## 3. Create the two KV namespaces

```sh
wrangler kv namespace create testgame-matches
wrangler kv namespace create testgame-usernames
```

Copy each returned `id` into the corresponding block in `wrangler.jsonc`.

Seed a few open matches so the lobby has something to show:

```sh
for id in arena-dust arena-river arena-forge; do
  wrangler kv key put --binding=MATCHES "$id" \
    "{\"id\":\"$id\",\"label\":\"Arena: ${id#arena-}\",\"status\":\"open\",\"maxPlayers\":8}"
done
```

## 4. Upload the signing key as a secret

The test game mints JWTs with the same private key your real backend will use. From the project root:

```sh
cd examples/testgame
cat ../../keys/<issuer>-private.pem | wrangler secret put THE_GAME_PRIVATE_KEY
```

## 5. Write the Worker

Full source is longer than fits here cleanly. The responsibilities are:

- `GET /` → validate `Cf-Access-Jwt-Assertion` against `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`, extract the user's email and a stable sub, serve HTML.
- `POST /api/username` → write `{email → username}` to the `USERNAMES` KV; reject duplicates and bad formats.
- `GET /api/matches` → list from `MATCHES` KV.
- `POST /api/join` → mint an RS256 JWT with claims `{iss, aud, sub, name, matchId, exp (12m), iat}` using `THE_GAME_PRIVATE_KEY` and `THE_GAME_KID`. Add `email` (taken from the Access identity) if you want it echoed back in the welcome frame; it is optional.
- Inline HTML page that imports the SDK IIFE, calls `/api/join`, opens the WebSocket, listens for `connected`, `message`, `blocked`, `rateLimited`, `standing`, `muted`, `error`, and renders them.

For the UI side, the pills that proved useful during development:

- `strikes: N` pill (yellow at 1-3, red at 4+) driven by the `standing` event
- `on watch (stricter filter)` pill when `standing.watch === true`
- `muted for Ns` pill with a `setInterval` tick that counts down and re-renders
- Chat input `disabled` whenever `standing.mutedUntil > Date.now()`; placeholder swaps to `muted for Ns`

See `packages/web/src/index.ts` for the exact event shapes. The SDK emits:

```ts
chat.on("standing",   (s) => { /* { strikes: number; watch: boolean; mutedUntil: number } */ });
chat.on("muted",      (m) => { /* { cid?: string; retryAfterMs: number } */ });
chat.on("blocked",    (b) => { /* { cid?: string; reason: string } */ });
chat.on("rateLimited",(r) => { /* { cid?: string; scope: "sub"|"ip"|"room"; retryAfterMs: number } */ });
```

If you want a working reference, build it once from the stubs above and keep it under `examples/testgame/` which is already gitignored. Future `pnpm run deploy` will rebuild and resync the SDK automatically.

## 6. Deploy

```sh
pnpm run deploy
```

`predeploy` triggers `sync-sdk`, then wrangler uploads. First deploy also provisions the custom domain binding for `game.chat.yourgame.com`.

## 7. Exercise it

Open the hostname in a browser. You should get an Access SSO prompt, then land on the username picker, pick a match, and see "connected as ... in match ..." in the chat panel.

Things to try:

| Action | Expected outcome |
|---|---|
| Say something clean | Appears in the message list for everyone in the room. |
| Say "fuck" (or any term in the shipped wordlist) | Local echo replaced with "Message blocked for violating our policy." No strike added (mild wordlist weight is 0 by default). |
| Say something targeted and hostile | Clef scores it, you see a block, strike count on the pill ticks up by 1 or 2. |
| Accumulate 5 effective strikes | You get a 1-minute mute. Input disables, placeholder shows a live countdown, red pill shows seconds remaining. |
| Spam >10 messages in 10s | `rateLimited` event, "Error: rate limited (your messages). try again in ~Ns." |
| Open two tabs to the same match | Each sees the other's `join` and `message` events; `standing` is per-user, so a mute in one tab leaves the other unaffected if they are different accounts. |

Watch the admin dashboard (`https://<admin_hostname>/admin`) in a second window to see offenders accumulate, drill into a user, pardon them, or apply a manual mute. Mutes applied with a `matchId` propagate live to the player's open socket.

## 8. Clean up

If you kill the test game, you can leave the Worker in place (it costs nothing when idle). To delete:

```sh
wrangler delete  # from examples/testgame
```

Remove the Access application from the dashboard. The KV namespaces persist until you delete them explicitly:

```sh
wrangler kv namespace delete --namespace-id=<matches-id>
wrangler kv namespace delete --namespace-id=<usernames-id>
```

## Reusing on a second account

Everything above assumed you were adding a test game to the same account where `terraform apply` ran. For a demo on a second account:

1. Clone this repo into a separate directory and run `terraform apply` there with the second account's `account_id`, `zone_id`, `chat_hostname`.
2. Repeat sections 1-6 of this document from that second clone, pointing at the second account's zone, team domain, and the new `./keys/<issuer>-private.pem` that `terraform apply` just generated.

Each clone keeps its own `terraform.tfstate`, so the two deployments stay fully isolated.
