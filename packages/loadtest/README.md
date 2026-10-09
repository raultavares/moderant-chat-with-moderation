# moderant loadtest

WebSocket-based load generator for the moderant chat endpoint. Mints synthetic JWTs locally, opens N bots, has them send scripted banter + edge-case messages, measures latency and categorizes outcomes.

## Setup

You need a deployed moderant stack to point this at (see `docs/DEPLOY.md`). The TF deploy generates a private key at `keys/<issuer>-private.pem`. The loadtest uses that same key to mint tokens with the matching issuer id.

Set these env vars before running (export in your shell, or put in `.env.local` and source it):

```sh
export MODERANT_ISSUER=my-game                       # a key in tfvars issuers
export MODERANT_KID=my-game-2026-10                  # that game's kid (terraform output issuers)
export MODERANT_CHAT_WS_BASE=wss://chat.yourgame.com # matches tfvars chat_hostname
# optional:
# export MODERANT_PRIVATE_KEY_PATH=/absolute/path/to/key.pem
# export MODERANT_AUDIENCE=moderant-chat
```

If `MODERANT_PRIVATE_KEY_PATH` is not set, the harness looks for `../../keys/${MODERANT_ISSUER}-private.pem` relative to the loadtest package (i.e. the layout Terraform creates).

## Run

```sh
pnpm install
pnpm exec tsx src/run.ts --profile=squad --duration=60
```

## Profiles

| Profile | Users | Rooms | Send interval | Game shape |
|---|---|---|---|---|
| `lobby`  | 150 | 10  | 2-5s   | pre-game lobby chatter |
| `squad`  | 30  | 5   | 15-25s | 3v3 ranked squads |
| `match`  | 150 | 10  | 10-20s | 5v5 competitive matches (Dota/LoL/OW) |
| `party`  | 150 | 3   | 20-40s | VRChat / social hubs, 50 per room |
| `hot`    | 150 | 1   | 1-3s   | one hot room, chat flood |
| `storm`  | 150 | 1   | 1-2s   | adversarial, rate-limiter stress |
| `mega`   | 300 | 1   | 2-4s   | 3-min stress of a single room |

Override via `--users=N --matches=N --duration=SECONDS --rate=MIN:MAX`.

Add `--unique` to defeat the AI Gateway cache (makes every message content unique). Use for cold-path latency measurement.

Add `--toxic=N` to make the first N bots send only slurs/threats. Use to exercise the discipline pipeline (strikes, watch, mute). Each run uses a unique sub prefix by default so strikes don't carry between runs; override with `--sub-prefix=<name>` to intentionally reuse identities.

## Output

Each run writes `runs/<timestamp>-<profile>-<users>u.csv` and `.json`. CSV columns:
`timestamp, botIndex, matchId, category, outcome, latencyMs, blockLayer, errorCode`.

Terminal shows aggregate summary (sent, confirmed/blocked/rate_limited/errored/timed_out, latency p50/p90/p95/p99, breakdown by category, blocked-layer distribution).

## What it tests

- JWT verification against TRUSTED_ISSUERS (if the key or kid are wrong, bots fail to connect)
- WebSocket upgrade + DO routing + warm-up fire path
- Full moderation pipeline (wordlist, Clef, Llama Guard) because the message corpus has a mix of banter, borderline, mild profanity, and slurs
- Rate limiters (per-sub, per-ip, per-room) depending on profile

It does NOT exercise your game backend's own `/mint` endpoint. For that, use `curl` + your real auth, or write an integration test in your own harness.
