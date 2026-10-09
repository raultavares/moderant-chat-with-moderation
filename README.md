# moderant

Embeddable, moderated, real-time chat for games. Runs end-to-end on Cloudflare.

## What you get

- WebSocket chat endpoint behind your own hostname, with per-match rooms backed by Durable Objects.
- Three-layer moderation pipeline (wordlist + Clef + Llama Guard) that catches harm while preserving gaming language.
- RS256-signed JWT auth where your game backend is the only identity authority.
- A browser SDK (`@moderant/web`) with React and Phaser integration helpers.
- Progressive discipline: strike/mute ladder, per-user profanity ranking, admin dashboard at `/admin`.
- Measured performance: p95 under 300ms end-to-end for realistic game shapes (3v3 squad, 5v5 match, 50-player party).

## Deploy (one command)

Prerequisites: a Cloudflare account on Workers Paid, a domain on Cloudflare, Terraform `>= 1.6`, Node `>= 22`, pnpm.

```sh
git clone <this-repo> moderant && cd moderant
pnpm install -r && pnpm build

cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# edit: account_id, zone_id, chat_hostname, admin_hostname, issuers

export CLOUDFLARE_API_TOKEN=cfat_...
cd terraform && terraform init && terraform apply
```

Full walkthrough: [docs/DEPLOY.md](./docs/DEPLOY.md).

Integration (backend mint endpoint + frontend SDK): [docs/INTEGRATE.md](./docs/INTEGRATE.md).

### API token permissions

Terraform reads `CLOUDFLARE_API_TOKEN` from your shell. Create a custom API token with at least these permissions on the target account:

| Permission | Level | When |
|---|---|---|
| Workers Scripts | Edit | Always (also covers the custom domain bindings) |
| Workers KV Storage | Edit | Always |
| D1 | Edit | Always |
| AI Gateway | Edit | Always |
| Access: Apps and Policies | Edit | Only if `chat_access_bypass = true` |

Creating, scoping, storing, and rotating the token is up to whoever runs the deploy.

## Architecture

```
          your game backend                        your game frontend
         ┌───────────────┐                        ┌─────────────────┐
         │ /chat-token   │                        │ @moderant/web   │
         │ signs RS256   │  ──── sends JWT ────►  │ opens WS        │
         └───────────────┘                        └────────┬────────┘
                                                           │
                        ┌──────────────────────────────────┘
                        ▼
         ┌──────────────────────────────┐
         │ moderant-chat (CF Worker)    │   TRUSTED_ISSUERS: {<iss>: public key}
         │ verifies JWT, routes to DO   │   RoomDO per matchId
         │ fans out messages            │   rate limits per sub/ip/room
         └───────────┬──────────────────┘
                     │ service binding
                     ▼
         ┌──────────────────────────────┐
         │ moderant-moderation          │   wordlist (KV)
         │ pipeline check per message   │   Clef (Workers AI via AI Gateway)
         │ fail-closed                  │   Llama Guard 3 (fallback)
         └──────────────────────────────┘
```

What Terraform provisions on your account:

- 4 Workers: `moderant-chat`, `moderant-moderation`, `moderant-warm`, `moderant-admin`
- 1 KV namespace: `moderant-wordlist` (pre-loaded with LDNOOBW English)
- 1 D1 database: `moderant-reputation` (strikes, mutes, violation history)
- 1 AI Gateway: `moderant-moderation` (1-hour cache)
- 2 Workers custom domain bindings (one for chat, one for admin)
- 1 RS256 keypair per game in `issuers` (generated locally; private keys never leave your machine)
- 1 random admin bearer token (`terraform output -raw admin_token`)
- Optional: 1 Access application with a "Bypass, Everyone" policy on the chat hostname, only when `chat_access_bypass = true` (for accounts that block hostnames without an Access application)

## Repo layout

```
moderant/
├── terraform/           ← infrastructure as code (deploy target)
├── worker-chat/         ← WebSocket chat worker + RoomDO
├── worker-moderation/   ← three-layer moderation pipeline
├── worker-warm/         ← Workers AI GPU warm-up
├── worker-admin/        ← admin dashboard + ranking/pardon/mute API
├── shared/              ← discipline module shared by chat and admin
├── packages/
│   ├── web/             ← @moderant/web browser SDK
│   └── loadtest/        ← ws-based load generator (profiles: squad, match, party, mega, storm)
├── docs/
│   ├── DEPLOY.md        ← full deploy walkthrough
│   ├── TEST_GAME.md     ← stand up a 15-minute self-hosted test game to validate end-to-end
│   └── INTEGRATE.md     ← mint endpoint + SDK usage
```

## Measured performance

Measured with `packages/loadtest` against a live deployment:

| Topology | p50 | p95 | p99 | error rate |
|---|---|---|---|---|
| 3-player squad (CS2/Valorant) | 77 ms | 287 ms | - | 0% |
| 5-player match (Dota/LoL/OW) | 69 ms | 145 ms | 251 ms | 0% |
| 50-player party (VRChat/social) | 69 ms | 142 ms | 371 ms | 0% |
| 300-player mega-room (3 min stress) | 95 ms | 262 ms | - | 0% |

## License

MIT.

## Disclaimer

Terraform writes each game's private signing key to `keys/`, and stores those private keys and the admin token in plain text in `terraform.tfstate`. Securing those files, and your Cloudflare API token, is your responsibility. The author accepts no responsibility for lost, leaked, or misused keys or tokens.
