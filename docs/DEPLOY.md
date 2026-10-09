# Deploy moderant to your Cloudflare account

Full chat infrastructure in a single `terraform apply`. No dashboard clicks after you have an API token.

## Prerequisites

- A Cloudflare account on the Workers Paid plan ($5/month base, Workers AI usage billed separately).
- A domain already on Cloudflare (any zone you own).
- Locally installed: Terraform `>= 1.6`, Node `>= 22`, pnpm.

## 1. Get a Cloudflare API token

> Why not `wrangler login`? Wrangler's OAuth flow issues scoped tokens that expire every hour and does NOT include the `AI Gateway: Edit` scope that Terraform needs to provision the moderation gateway. The Terraform provider only accepts long-lived API tokens or legacy global keys. One-time token creation is the industry norm for IaC on Cloudflare.

Create a custom API token with the minimum permissions listed in the [README](../README.md#api-token-permissions). Creating, scoping, storing, and rotating the token is up to you.

Export it in your shell before every Terraform session:

```sh
export CLOUDFLARE_API_TOKEN=cfat_your_token_here
```

The Terraform provider reads this env var automatically. The token never goes into any committed file.

**Tip:** keep the token in `.env.local` (gitignored) and `source .env.local` when you start a session, or use direnv to auto-load. Both are optional conveniences; the one-liner export works fine.

## 2. Note your account ID and zone ID

- Account ID: dashboard sidebar on any Cloudflare page.
- Zone ID: dashboard → your domain → overview page, right sidebar.

## 3. Configure Terraform variables

```sh
git clone <this-repo> moderant
cd moderant
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit `terraform/terraform.tfvars` and fill:

```hcl
account_id     = "<your account id>"
zone_id        = "<your zone id>"
chat_hostname  = "chat.yourgame.com"         # subdomain of your zone
admin_hostname = "admin.chat.yourgame.com"   # subdomain of your zone

issuers = {
  "my-game" = {}   # map key = JWT iss claim for this game
}
```

`issuers` lists every game allowed to mint chat tokens. Each game gets its own RS256 keypair, so one game's leaked key never lets someone impersonate players of another, and strikes and mutes are tracked per game. Start with one; see [Adding another game](#adding-another-game) below.

Everything else has sensible defaults (rate limits, clef threshold, wordlist). Override in tfvars if needed.

## 4. Build the worker bundles

```sh
pnpm install -r
pnpm build
```

This produces `worker-*/dist/worker.js` for each worker. Terraform uploads these.

## 5. Apply

```sh
cd terraform
terraform init
terraform apply
```

Review the plan, type `yes` to confirm. First apply takes about 60-90 seconds. Fresh accounts and existing deploys both just work: the Durable Object migration shape is auto-selected based on whether the chat worker already exists on your account.

## 6. Grab the handoff block

```sh
terraform output handoff
```

You'll see something like:

```
============================================================
moderant chat deployed. Hand this block to your dev team.
============================================================

WebSocket URL:   wss://chat.yourgame.com/rooms/<matchId>/ws
Health check:    curl https://chat.yourgame.com/healthz

JWT signing (each game's /mint endpoint):
  Algorithm:     RS256
  aud:           moderant-chat
  Required JWT claims:
    iss, aud, sub (stable player id), name (display),
    matchId, exp (10-15 min), iat
  Optional: email

Games (one keypair each; give a game only its own private key):
  my-game
    iss:           my-game
    kid:           my-game-2026-10
    Private key:   ./../keys/my-game-private.pem
...
```

Each game's private key is on your disk at `keys/<issuer>-private.pem`. **Upload it to that game's backend secret manager and never commit it.** The same details are available as structured data via `terraform output issuers`.

## 7. Verify

```sh
curl https://chat.yourgame.com/healthz
# {"ok":true,"service":"moderant-chat","version":"0.1.0"}

curl https://admin.chat.yourgame.com/admin/healthz
# {"ok":true,"service":"moderant-admin","version":"0.1.0"}
```

## 8. Open the admin dashboard

The admin UI lives at `https://<admin_hostname>/admin` (set `admin_hostname` in your tfvars, e.g. `admin.chat.yourgame.com`). Get your admin token:

```sh
terraform output -raw admin_token
```

Paste it into the dashboard. You'll see:

- **Top offenders:** global ranking by average profanity score, current strikes, or severe block count.
- **Room roster:** type a `matchId` to see who's connected right now, each with session + lifetime stats, strike count, and watch/mute state.
- **User detail:** click any user to see their last 50 violations, pardon them, or apply a manual mute (5m / 30m / 24h).

The token is never exposed in the HTML; it lives only in your browser's sessionStorage. Rotate by changing `admin_token` in Terraform state and re-applying.

## 9. Try it with a test game (optional)

Before wiring moderant into your real game, you can validate the full chat + moderation + admin loop end-to-end by standing up a tiny self-hosted test game Worker. It mints JWTs, opens a WebSocket, and renders strikes, mutes, watch mode, and rate limits in the UI. See [TEST_GAME.md](./TEST_GAME.md) for the ~15-minute walkthrough.

Once the test game is working, follow [INTEGRATE.md](./INTEGRATE.md) to wire your game backend and frontend.

---

## What Terraform just created on your account

- 4 Workers: `moderant-chat`, `moderant-moderation`, `moderant-warm`, `moderant-admin`
- 1 KV namespace: `moderant-wordlist` (with LDNOOBW English wordlist pre-loaded)
- 1 D1 database: `moderant-reputation` (strikes, mutes, violation history)
- 1 AI Gateway: `moderant-moderation` (cache_ttl=3600, logs on)
- 2 Workers custom domain bindings:
  - `chat.yourgame.com` → `moderant-chat`
  - `admin.chat.yourgame.com` → `moderant-admin`
- Optional, only when `chat_access_bypass = true`: 1 Access application with a "Bypass, Everyone" policy on the chat hostname (keeps chat public on accounts that block unmatched hostnames)
- 1 random admin bearer token (surfaced via `terraform output -raw admin_token`)
- 1 RS256 keypair per game in `issuers`, generated locally; public keys are uploaded to the chat worker, private keys stay in `keys/`

Everything is managed as code. To change rate limits, edit `terraform.tfvars` and `terraform apply`. To destroy everything, `terraform destroy`.

## Updating code

When you change worker source code:

```sh
pnpm build
cd terraform && terraform apply
```

`content_sha256` on each worker triggers an update when the bundled file changes.

## Updating configuration

Edit `terraform/terraform.tfvars` (rate limits, clef threshold, etc.), then `terraform apply`.

## Adding another game

One chat deployment can serve any number of games. Add an entry to `issuers`:

```hcl
issuers = {
  "my-game"    = {}
  "other-game" = {}
}
```

Then `terraform apply`. The plan only adds a keypair and key files for the new game and updates the chat worker's `TRUSTED_ISSUERS` secret; existing games and their keys are untouched. Hand the new game's team its own block from `terraform output handoff` and its own `keys/other-game-private.pem`.

- Tokens are checked against the key of the game named in their `iss` claim. A game cannot sign tokens for another game's `iss`; that fails with close code `4003 verify_failed`.
- Strikes, mutes, and violation history are keyed by `(iss, sub)`, so each game's players have independent standing even if two games happen to reuse the same player id.
- Removing a game from the map deletes its keypair and key files and makes the chat reject its tokens with `4002 unknown_issuer`. Its history stays in D1.
- Renaming a game is a remove plus an add: it gets a new keypair and its players start with clean standing.

## Troubleshooting

**`Error: no valid credential sources found`**
`CLOUDFLARE_API_TOKEN` is not exported in the shell running terraform. Re-export and retry.

**`412 Precondition Failed ... Actor migration tag precondition failed`**
A previous `moderant-chat` script existed outside Terraform state. Delete it from the dashboard or via:
```sh
curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/moderant-chat?force=true" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```
Then re-run `terraform apply`.

**Plan shows the chat worker will be modified every time**
Cosmetic drift on the ROOM Durable Object binding `namespace_id` (CF-assigned, not in your tfvars). Running `apply` is safe and idempotent at the API level.

**Workers AI first request takes 10-20s**
Normal cold start. The warm worker fires on each WebSocket upgrade to mitigate; subsequent requests land in the 70-800 ms range.

**Chat hostname redirects to an Access login, or returns error 1050**
Your account has Zero Trust "Block traffic to all domains in this account" turned on, so hostnames without an Access application are blocked. Set `chat_access_bypass = true` in `terraform.tfvars` and `terraform apply`. Your token also needs "Access: Apps and Policies: Edit" for that.

**Upgrading from a version where the chat Access app was always created**
`chat_access_bypass` defaults to `false`, so the next apply would delete that app. If your account blocks unmatched hostnames, set `chat_access_bypass = true` first; the plan then only moves the existing app to its new address and changes nothing.

**Upgrading a deploy that used `issuer_id` / `issuer_kid`**
Older versions took a single game via `issuer_id` and `issuer_kid`. Replace them in `terraform.tfvars` with `issuers = { "<your issuer_id>" = { kid = "<your issuer_kid>" } }`, then move the existing key into the new address before planning so it is not regenerated:
```sh
cd terraform
ID=<your issuer_id>
terraform state mv 'tls_private_key.issuer' "tls_private_key.issuer[\"$ID\"]"
terraform state mv 'local_sensitive_file.issuer_private_pem' "local_sensitive_file.issuer_private_pem[\"$ID\"]"
terraform state mv 'time_static.issuer_kid' "time_static.issuer_kid[\"$ID\"]"
terraform apply
```
The plan should show the chat and admin workers updated in place, a new `keys/<id>-public.pem`, and the old JWK helper resources removed. If it shows `tls_private_key.issuer["<id>"]` being created, stop: a state move was missed and applying would rotate the key.

## Costs

Rough guidance (estimates; your bill depends on message volume and Workers AI usage):

| Scale | Monthly cost |
|---|---|
| Indie (10K matches/day, 10 players) | ~$150 |
| Mid-size (100K matches/day) | ~$1,500 |
| Social (10K persistent 50-player rooms) | ~$3,000 |
| AAA (1M matches/day, 100 players) | ~$120,000 |

## Teardown

```sh
cd terraform
terraform destroy
```

Removes everything listed in "What Terraform just created", including the key files Terraform wrote under `keys/`. Copy any private key you still need elsewhere before destroying.
