# @moderant/web

Drop-in chat SDK for web games. One class, one line to send, built-in AI moderation.

- **WebSocket chat** that just works
- **AI moderation** runs server-side before messages reach other players
- **Optimistic UX**: the sender sees their message instantly, moderation happens in parallel
- **Framework-agnostic**: works in vanilla JS, React, Vue, Phaser, PixiJS, anything
- **~9 KB** ESM, zero runtime dependencies

The SDK owns the connection, JWT lifecycle, keepalive, reconnect, and outbox. You own rendering and your game's mint endpoint.

---

## Install

```sh
npm install @moderant/web
# or
pnpm add @moderant/web
# or
yarn add @moderant/web
```

Also available as a self-contained IIFE at `dist-iife/index.global.js` (exposes global `Moderant`).

---

## 60-second quick start

```ts
import { Moderant } from "@moderant/web";

const chat = new Moderant();

chat.on("message", ({ from, text }) => {
  console.log(`${from.name}: ${text}`);
});

chat.on("blocked", ({ cid }) => {
  console.log(`your message ${cid} was blocked by the moderator`);
});

await chat.join({
  matchId: "match-123",
  mint: async (matchId) => {
    // Call YOUR game backend; it returns a signed chat JWT.
    const r = await fetch(`/api/chat-token?matchId=${matchId}`);
    return r.json(); // { token, wsUrl, matchId, expiresAt }
  },
});

const cid = chat.send("gg wp");
// cid lets you track moderation outcome for this specific message
```

That's it. Three events to care about: `message`, `blocked`, `rateLimited`.

---

## How moderation works (what you need to know)

Three layers run server-side, in order, before any peer sees a message:

1. **Wordlist** — deterministic slur list (~1 ms). Catches obvious hate speech.
2. **Shortcuts** — allow list for common gaming phrases like `gg`, `wp`, `nice shot` (~0 ms). Bypasses AI entirely.
3. **Clef** — Cloudflare's decision model, gaming-aware (~70-800 ms). Catches threats, doxxing, self-harm, sexual content, slur variants that slip past the wordlist.

What passes:
- in-game violence: `"lets kill them next round"`, `"nuke their base"`, `"snipe him from the tower"`
- trash talk: `"ez game ez life"`, `"you aim like a bot"`, `"pathetic performance"`
- mild profanity: `"holy shit nice shot"`, `"fucking campers i swear"`

What's blocked:
- identity slurs (any variant)
- real-world threats: `"i know where you live"`, `"i will find your house"`
- self-harm directed at a person: `"kys loser"`, `"go kill yourself irl"`
- sexual content involving real people or minors
- real-world weapon/violence instructions

**Senders always see their own message instantly** (optimistic UI). Only peers wait for moderation to finish.

---

## The mint endpoint (what your backend needs to do)

The SDK calls `mint(matchId)` whenever it needs a chat JWT. Your backend:

1. Authenticates the player (however you already do it)
2. Decides whether this player is allowed in this match
3. Signs a short-lived JWT (RS256) with your private key, bound to the matchId
4. Returns `{ token, wsUrl, matchId, expiresAt }`

The chat JWT claims the SDK needs:

```json
{
  "iss": "your-game-id",
  "aud": "moderant-chat",
  "sub": "<player id, stable>",
  "name": "<display name>",
  "email": "<optional>",
  "matchId": "<must match the room being joined>",
  "exp": <unix seconds, recommend 10-15 min>,
  "iat": <unix seconds>
}
```

The public key for your `iss` is registered with the chat worker via its `TRUSTED_ISSUERS` secret (Terraform does this for you at deploy time; see `docs/DEPLOY.md`).

The `wsUrl` is the chat endpoint on your deployed moderant instance:

```
wss://<your-chat-hostname>/rooms/<matchId>/ws
```

---

## API reference

### `new Moderant()`

No arguments. Create one instance per chat room you want to show.

### `chat.join(options): Promise<WelcomeInfo>`

Opens the WebSocket, performs the hello handshake, resolves when the server welcomes you. Rejects if mint fails or server rejects the token.

```ts
await chat.join({
  matchId: "match-abc",
  mint: async (matchId) => ({ token, wsUrl, matchId, expiresAt }),
});
```

`WelcomeInfo` is `{ sub, name, email?, matchId }`, the server's view of who you are. `email` is present only if the chat JWT carried it.

### `chat.send(text: string): string`

Returns a **correlation id** (`cid`). Use it to correlate the message with its moderation outcome (`message` self-echo, `blocked`, or `rateLimited`).

If the connection is dead, the SDK queues the message (up to 50) and lazy-reconnects. Throws `outbox_full` if the queue is full, `not_joined` if you haven't called `join()`.

```ts
const cid = chat.send("gg wp");
pendingBubbles.set(cid, { text: "gg wp", status: "pending" });
```

### `chat.leave(): void`

Closes the connection cleanly, drops all state. Call this when the player leaves the match.

### `chat.on(event, listener)` / `chat.off(event, listener)`

Type-safe event subscription. Listeners never throw into the SDK; thrown errors are logged.

### Events

| Event | Payload | When |
|---|---|---|
| `connected` | `{ sub, name, email?, matchId }` | Server welcomed you. You can now send. `email` only if the token had one. |
| `disconnected` | `{ code, reason }` | WebSocket closed. SDK reconnects lazily on next send. |
| `message` | `{ from: {sub,name}, text, at, cid? }` | A chat message arrived. `cid` is set only on self-echo. |
| `join` | `{ sub, name }` | Another player joined the room. |
| `leave` | `{ sub, name }` | Another player left. |
| `blocked` | `{ cid?, layer }` | Your message was blocked by moderation. `layer` is `"wordlist"`, `"clef"`, `"guardrails"`, or `"unavailable"`. |
| `rateLimited` | `{ cid?, scope, retryAfterMs }` | You're sending too fast. `scope` is `"sub"`, `"ip"`, or `"room"`. |
| `error` | `{ cid?, code }` | A protocol-level error. |

### Rate limits (hosted service defaults)

- Per user: **10 messages per 10 seconds**
- Per IP: **60 messages per 10 seconds** (protects shared NAT scenarios)
- Per room: **100 messages per 10 seconds**

Rate-limited messages fire a `rateLimited` event with the `scope` so you can tell the player why.

---

## Correlation IDs and optimistic UX

`send()` returns a `cid`. The server echoes it back only to the sender, in one of three events:

- `message` — accepted, broadcast to all peers (self-echo includes your cid)
- `blocked` — rejected by moderation
- `rateLimited` — rejected by the rate limiter

Pattern for optimistic rendering:

```ts
const pending = new Map<string, HTMLElement>();

function sendMessage(text: string) {
  const cid = chat.send(text);
  const el = renderPendingBubble(text); // gray/italic bubble
  pending.set(cid, el);
}

chat.on("message", ({ cid, text, from }) => {
  if (cid && pending.has(cid)) {
    // Our own message confirmed by the server
    confirmBubble(pending.get(cid)!, text);
    pending.delete(cid);
  } else {
    // A peer's message
    renderPeerBubble(from.name, text);
  }
});

chat.on("blocked", ({ cid }) => {
  if (cid && pending.has(cid)) {
    rejectBubble(pending.get(cid)!, "blocked by moderation");
    pending.delete(cid);
  }
});

chat.on("rateLimited", ({ cid, retryAfterMs }) => {
  if (cid && pending.has(cid)) {
    rejectBubble(pending.get(cid)!, `slow down (${retryAfterMs}ms)`);
    pending.delete(cid);
  }
});
```

Peers (everyone else) just see the final `message` event with no cid — they never knew about the pending state.

---

## React integration

Minimal hook, no state library needed:

```tsx
import { useEffect, useRef, useState } from "react";
import { Moderant, type IncomingMessage } from "@moderant/web";

export function useChat(matchId: string) {
  const chatRef = useRef<Moderant | null>(null);
  const [messages, setMessages] = useState<IncomingMessage[]>([]);
  const [pending, setPending] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const chat = new Moderant();
    chatRef.current = chat;

    chat.on("message", (msg) => {
      setMessages((m) => [...m, msg]);
      if (msg.cid) {
        setPending((p) => {
          const next = new Map(p);
          next.delete(msg.cid!);
          return next;
        });
      }
    });

    chat.on("blocked", ({ cid }) => {
      if (cid) {
        setPending((p) => {
          const next = new Map(p);
          next.set(cid, "blocked");
          return next;
        });
      }
    });

    chat.on("rateLimited", ({ cid }) => {
      if (cid) {
        setPending((p) => {
          const next = new Map(p);
          next.set(cid, "rate-limited");
          return next;
        });
      }
    });

    chat.join({
      matchId,
      mint: async (mid) => {
        const r = await fetch(`/api/chat-token?matchId=${mid}`);
        return r.json();
      },
    });

    return () => chat.leave();
  }, [matchId]);

  const send = (text: string) => {
    const cid = chatRef.current?.send(text);
    if (cid) setPending((p) => new Map(p).set(cid, "pending"));
    return cid;
  };

  return { messages, pending, send };
}
```

Component:

```tsx
function ChatPanel({ matchId }: { matchId: string }) {
  const { messages, pending, send } = useChat(matchId);
  const [input, setInput] = useState("");

  return (
    <div className="chat">
      <ul>
        {messages.map((m, i) => (
          <li key={i}>
            <b>{m.from.name}:</b> {m.text}
            {m.cid && pending.get(m.cid) === "blocked" && " [blocked]"}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
          setInput("");
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} />
      </form>
    </div>
  );
}
```

---

## Phaser integration

The SDK is engine-agnostic. In Phaser, treat it as a service you create once in your boot scene and keep on `game.registry`:

```ts
import Phaser from "phaser";
import { Moderant } from "@moderant/web";

export class BootScene extends Phaser.Scene {
  create() {
    const chat = new Moderant();
    this.registry.set("chat", chat);

    chat.join({
      matchId: this.registry.get("matchId") as string,
      mint: async (matchId) => {
        const r = await fetch(`/api/chat-token?matchId=${matchId}`);
        return r.json();
      },
    });

    this.scene.start("GameScene");
    this.scene.launch("ChatOverlay");
  }
}
```

Then any scene can grab it:

```ts
export class ChatOverlay extends Phaser.Scene {
  private chat!: Moderant;
  private log!: Phaser.GameObjects.Text;

  create() {
    this.chat = this.registry.get("chat");
    this.log = this.add.text(16, 16, "", { fontSize: "14px", color: "#fff" });

    const lines: string[] = [];
    const push = (s: string) => {
      lines.push(s);
      if (lines.length > 10) lines.shift();
      this.log.setText(lines.join("\n"));
    };

    this.chat.on("message", ({ from, text }) => push(`${from.name}: ${text}`));
    this.chat.on("blocked", () => push("[your message was blocked]"));
    this.chat.on("rateLimited", () => push("[slow down]"));

    // Press Enter, type, Enter to send.
    // (Use an HTML input overlay for real text entry; Phaser input is for games, not forms.)
    this.input.keyboard?.on("keydown-ENTER", () => this.openInput());
  }

  private openInput() {
    const text = window.prompt("say something");
    if (text) this.chat.send(text);
  }
}

export class GameScene extends Phaser.Scene {
  create() {
    // Your actual game. Chat is already running in the overlay scene.
  }
}
```

For a nicer input UX, overlay an HTML `<input>` positioned over the Phaser canvas, or use a lib like `rexInputText`. The Moderant SDK doesn't care how you capture text.

---

## Testing locally (no backend required for exploration)

For local experimentation you can mint tokens yourself with any JOSE-compatible library. See `packages/loadtest/src/mint.ts` in this repo for a reference RS256 minter. **Do not use this pattern in production** — the signing key belongs on your backend.

---

## FAQ

**Can I run my own moderation policy?**
The hosted service uses Cloudflare Clef with a gaming-aware prompt. For a bespoke policy, run your own `worker-moderation` with your own prompt and threshold. The chat Worker calls it via a service binding.

**What happens on disconnect?**
`disconnected` fires. Pending messages stay in your UI as pending. When you call `send()` again, the SDK lazy-reconnects, re-mints the token if needed, and flushes the outbox (max 50 queued).

**What about voice?**
Not in this SDK. Text only. Voice moderation needs transcription first and lives in a different pipeline.

**What about history / message persistence?**
Not persisted. Each room is a Durable Object that only lives while people are connected. If you need history, log messages on your own backend from the `message` event.

**Can I use this without a game?**
Yes. It's a WebSocket chat with moderation. Nothing about it is game-specific except the model's gaming-aware prompt (which keeps "lets kill them" from being flagged).

---

## License

MIT.
