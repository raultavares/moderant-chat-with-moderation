# Integrate moderant into your game

Prerequisite: you've run `terraform apply` (see [DEPLOY.md](./DEPLOY.md)) with your game listed in `issuers`, and have the handoff block showing your `chat_hostname` plus your game's `iss`, `kid`, and private key path. Each game uses only its own entry.

> Not sure the stack is wired correctly yet? Spin up the self-hosted test game in [TEST_GAME.md](./TEST_GAME.md) first. It exercises the full chat + moderation + admin loop in about fifteen minutes without touching your real backend.

Two things to build:

1. A `/mint` endpoint on your game backend that signs chat JWTs for authenticated players.
2. Frontend code that uses `@moderant/web` to connect and chat.

---

## 1. Backend: the mint endpoint

Any language with a JWT library works. The chat worker only cares that:

- The JWT is signed RS256 with **your game's** private key (`keys/<your iss>-private.pem`). A token signed with another game's key fails with close code `4003 verify_failed`.
- The header has `alg: "RS256"`, `kid: "<your game's kid>"`, `typ: "JWT"`.
- The payload has `iss`, `aud: "moderant-chat"`, `sub` (stable player id), `name` (display), `matchId`, `exp`, `iat`. `email` is optional; omit it if your game has no email for the player (guest, Steam, console accounts).
- `sub` must be stable across sessions and renames. Strikes and mutes are keyed by `(iss, sub)`, so a player cannot shed discipline by changing display name.
- A token that signs and verifies but lacks `sub`, `name`, or `matchId` is closed right after the hello frame with WebSocket close code `4003` and reason `missing_claims`. Your mint endpoint still returns 200 in that case, so check the close code when debugging a connection that drops instantly.
- `exp - iat` is short (10 to 15 minutes recommended; 1 hour maximum).

### Node reference (Express + jose)

```ts
import express from "express";
import { readFileSync } from "node:fs";
import * as jose from "jose";

const app = express();
app.use(express.json());

const PRIVATE_KEY_PEM = readFileSync(process.env.MODERANT_PRIVATE_KEY_PATH!, "utf8");
const ISSUER = process.env.MODERANT_ISSUER!;           // "my-game"
const KID = process.env.MODERANT_KID!;                  // "my-game-2026-10"
const CHAT_WS_BASE = process.env.MODERANT_WS_BASE!;     // "wss://chat.yourgame.com"
const AUDIENCE = "moderant-chat";
const TTL_SECONDS = 10 * 60; // 10 minutes

let keyPromise: Promise<CryptoKey> | null = null;
async function getKey() {
  if (!keyPromise) keyPromise = jose.importPKCS8(PRIVATE_KEY_PEM, "RS256") as Promise<CryptoKey>;
  return keyPromise;
}

app.post("/api/chat-token", async (req, res) => {
  // Replace with your real auth. The chat worker doesn't verify identity; your
  // backend is the trust boundary. Only mint tokens for users you've already
  // authenticated through your own flow.
  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: "unauthenticated" });

  const { matchId } = req.body as { matchId?: string };
  if (!matchId || typeof matchId !== "string") {
    return res.status(400).json({ error: "missing_matchId" });
  }

  // Enforce your own gating. For example: is this user actually in this match?
  const allowed = await userIsInMatch(user.id, matchId);
  if (!allowed) return res.status(403).json({ error: "not_in_match" });

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TTL_SECONDS;
  const key = await getKey();
  const token = await new jose.SignJWT({
    name: user.displayName,
    email: user.email,  // optional; omit if your game has no email
    matchId,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);

  res.json({
    token,
    wsUrl: `${CHAT_WS_BASE}/rooms/${encodeURIComponent(matchId)}/ws`,
    matchId,
    expiresAt: exp,
  });
});
```

A full working reference lives at `packages/loadtest/src/mint.ts`. For a browser test game that mints tokens behind Cloudflare Access, see [TEST_GAME.md](./TEST_GAME.md).

### Other languages

Any JWT library that supports RS256 works. Load `keys/<issuer>-private.pem` (PKCS#8), sign with the claims above. Examples:

- Go: `github.com/golang-jwt/jwt/v5`
- Python: `PyJWT` with `algorithm="RS256"`
- Rust: `jsonwebtoken` crate
- Java: `com.auth0:java-jwt`

---

## 2. Frontend: the SDK

```sh
npm install @moderant/web
```

### Minimal integration

```ts
import { Moderant } from "@moderant/web";

const chat = new Moderant();

chat.on("connected", () => console.log("ready to chat"));
chat.on("message", (m) => console.log(`${m.from.name}: ${m.text}`));
chat.on("blocked", (b) => console.warn("your message was blocked:", b.layer));
chat.on("rateLimited", (r) => console.warn("slow down:", r.scope, r.retryAfter));
chat.on("error", (e) => console.error(e.code));

await chat.join({
  matchId: "match-abc-123",
  mint: async (matchId) => {
    const r = await fetch("/api/chat-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ matchId }),
    });
    if (!r.ok) throw new Error(`mint failed: ${r.status}`);
    return r.json(); // { token, wsUrl, matchId, expiresAt }
  },
});

chat.send("gg wp");
```

### Events emitted

| Event | Payload | When |
|---|---|---|
| `connected` | `{ you }` | WS open + welcome received |
| `disconnected` | `{ code, reason }` | WS closed |
| `message` | `{ from, text, at, cid? }` | A message was accepted and broadcast |
| `join` | `{ p }` | Another player joined |
| `leave` | `{ p }` | Another player left |
| `blocked` | `{ layer, severity?, cid? }` | Your message was blocked. `layer` is `wordlist`, `clef`, or `guardrails`. For `wordlist` blocks, `severity` is `"mild"` (casual swear) or `"severe"` (slur). |
| `rateLimited` | `{ scope, retryAfterMs, cid? }` | You're being throttled. `scope` is `sub`, `ip`, `room`, or `watch` (tighter limit applied to users under scrutiny). |
| `muted` | `{ retryAfterMs, cid? }` | You're muted. The server did not run moderation or broadcast. `retryAfterMs` is time until the mute expires. |
| `standing` | `{ strikes, watch, mutedUntil }` | Your discipline standing changed (sent on connect if non-zero, after each strike, and after admin pardon/mute). Use to render a "you have N strikes" UI if you want. |
| `error` | `{ code, scope?, retryAfter?, cid? }` | Protocol or network error |

### Correlation IDs for optimistic UI

```ts
const cid = chat.send("hello world");  // returns a cid
// render the message optimistically with pending state
chat.on("message", (m) => {
  if (m.cid === cid) markAsConfirmed(cid);
});
chat.on("blocked", (b) => {
  if (b.cid === cid) markAsBlocked(cid, b.layer);
});
```

Full SDK docs including React + Phaser integration patterns: [packages/web/README.md](../packages/web/README.md).

---

## 3. What moderation does for you

Every message goes through:

1. **Wordlist** (deterministic, <5ms): LDNOOBW English list, loaded into KV by Terraform. Blocks obvious slurs and profanity instantly. Hits are tagged `severity: "mild"` (casual swear from the `mild_terms` tfvar) or `"severe"` (slurs and the rest). Only severe hits produce discipline strikes; mild hits are blocked but don't penalize the user.
2. **Clef** (AI, ~70-800ms): Cloudflare's own classifier. Catches contextual harm, slurs with typos, grooming, threats.
3. **Llama Guard 3** (fallback, ~500ms): if Clef errors or times out, this backs it up. Fail-closed: on any pipeline error, the message is blocked.

Gaming context is preserved. "lets kill them next round" passes. "kys loser" blocks. Measured on a 24-case battery during development.

To tune, override in `terraform.tfvars`:

```hcl
clef_threshold = "0.2"   # more aggressive (default: 0.3)
mild_terms     = ["fuck", "shit", "damn", "bitch", "ass", "bastard", "crap", "hell"]
```

To add more wordlists (other languages), use `wrangler kv key put` directly against the KV namespace ID that Terraform output:

```sh
export NS_ID=$(terraform output -raw wordlist_namespace_id)
curl -sS https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/es \
  | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))" \
  > /tmp/es.json
wrangler kv key put --namespace-id=$NS_ID es --path=/tmp/es.json --remote
```

---

## 4. Protocol reference (if you're not using the SDK)

The chat worker speaks a tiny JSON-over-WebSocket protocol on `wss://<chat_hostname>/rooms/<matchId>/ws`.

**Client → Server:**
- `{ "t": "hello", "token": "<jwt>" }` — must be the first frame, within 10s of connect.
- `{ "t": "say", "text": "...", "cid": "optional-correlation-id" }`
- `{ "t": "ping" }` — keepalive.

**Server → Client:**
- `{ "t": "welcome", "you": {...} }`
- `{ "t": "join", "p": {...} }` / `{ "t": "leave", "p": {...} }`
- `{ "t": "say", "from": {...}, "text": "...", "at": 1234567890, "cid"? }`
- `{ "t": "pong" }`
- `{ "t": "blocked", "layer": "wordlist|clef|guardrails", "severity"?: "mild|severe", "cid"? }`
- `{ "t": "standing", "strikes": N, "watch": bool, "mutedUntil": ms_epoch }`
- `{ "t": "error", "code": "rate_limit|muted|...", "scope"?, "retryAfter"?, "cid"? }`

**Close codes:**
- 4000 `handshake_timeout`
- 4001 `invalid_hello`
- 4002 `unknown_issuer` — JWT iss claim doesn't match TRUSTED_ISSUERS
- 4003 `verify_failed` — signature, exp, or aud wrong
- 4004 `match_mismatch` — JWT matchId doesn't match URL path

The SDK handles all of this; the raw protocol is here for when you need a custom client (Unity C#, Unreal C++, etc.).

---

## 5. Discipline (strikes, mute, ranking)

Moderant tracks per-user reputation in D1 and penalizes repeat offenders. All thresholds are tfvars.

**Scoring (profanity level per message, 0..1):**
- Clean: Clef unsafe probability (usually near 0).
- Blocked by severe wordlist or Llama Guard: 1.0.
- Blocked by mild wordlist: 0.5.
- Blocked by Clef: the Clef probability itself.
- Unavailable / rate-limited / muted: not counted toward the user's average.

**Strike weights:**
- Severe wordlist = 2 strikes.
- Clef block with score ≥ 0.8 = 2.
- Clef block < 0.8 or Llama Guard = 1.
- Mild wordlist = 0 (blocked but no strike).

**Ladder (defaults, overridable):**
- 3 points: **watch** — stricter Clef threshold + tighter rate limit.
- 5 points: mute 1 minute.
- 8 points: mute 5 minutes.
- 12 points: mute 10 minutes.
- 15 points: mute 30 minutes.

**Decay:** 1 strike forgiven per hour of good behavior. No cron; computed lazily on each read.

**Muted users:** the server sends `{ "t":"error", "code":"muted", "retryAfter": ms_until_unmute }` immediately. No moderation call, no rate-limit charge, no broadcast. Zero cost to you while a user is muted.

## 6. Admin API

The dashboard at `https://<admin_hostname>/admin` is a thin wrapper over this JSON API. All endpoints require `Authorization: Bearer <admin_token>` (get it with `terraform output -raw admin_token`). The admin lives on its own hostname (set via the `admin_hostname` tfvar); put Cloudflare Access in front of it in production.

| Method | Path | What |
|---|---|---|
| GET | `/admin/api/offenders?order=avg\|strikes\|blocks&min_msgs=20&limit=50` | Global ranking |
| GET | `/admin/api/rooms/:matchId` | Live roster of a room: who's connected, their session + lifetime stats, strike/watch/mute state |
| GET | `/admin/api/users/:iss/:sub` | One user's full standing + last 50 violations |
| POST | `/admin/api/users/:iss/:sub/pardon` | Zeroes current strikes + mute. Body: `{ "matchId"?: "..." }` (if given, applies live to open sockets in that room) |
| POST | `/admin/api/users/:iss/:sub/mute` | Manual mute. Body: `{ "matchId"?: "...", "durationMs": 300000 }` |

The HTML dashboard covers the common cases (ranking → room → user → pardon/mute). Use the raw API if you want to integrate rankings into your own game backend's moderator UI.
