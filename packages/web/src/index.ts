/**
 * @moderant/web
 *
 * Drop-in chat SDK with built-in AI moderation.
 *
 * The SDK owns:
 *   - Chat JWT lifecycle (fetch, cache, re-mint before expiry)
 *   - WebSocket connection, hello handshake
 *   - Keepalive pings (30s)
 *   - Lazy reconnect on send-while-dead
 *   - Outbox for messages queued during disconnect
 *   - Correlation IDs (cid) for optimistic UX
 *   - Event emission: welcome, message, join, leave, blocked, rateLimited, error, connected, disconnected
 *
 * The game owns:
 *   - Rendering (UI is 100% up to you)
 *   - Supplying a `mint` function that returns a chat JWT
 *   - Deciding what to do with events
 */

// ---------- Types ----------

export interface MintResult {
  /** Chat JWT, signed by the game studio with a key registered with Moderant. */
  token: string;
  /** `wss://...` URL to the chat room. Returned by the mint endpoint. */
  wsUrl: string;
  /** The matchId this token is bound to. Must match the room being joined. */
  matchId: string;
  /** Expiry in seconds since epoch. SDK re-mints before this. */
  expiresAt: number;
}

export interface JoinOptions {
  /**
   * Called by the SDK whenever it needs a fresh JWT (initial connect or
   * before expiry). You implement this; it's where you call your game's
   * backend mint endpoint.
   */
  mint: (matchId: string) => Promise<MintResult>;
  /** The match room to join. */
  matchId: string;
}

export interface IncomingMessage {
  /** The sender's stable identity. */
  from: { sub: string; name: string };
  /** The message text (already moderated by the server). */
  text: string;
  /** Server-assigned timestamp in ms since epoch. */
  at: number;
  /**
   * Correlation ID. Present only on sender-side self-echoes; peers never
   * see this. Use it to confirm a pending bubble.
   */
  cid?: string;
}

export interface WelcomeInfo {
  sub: string;
  name: string;
  /** Present only if the chat JWT carried an `email` claim. */
  email?: string;
  matchId: string;
}

export interface PlayerRef {
  sub: string;
  name: string;
}

export interface BlockedEvent {
  /** The cid of the sent message that was blocked. */
  cid?: string;
  /** Which moderation layer blocked it. Opaque to the game. */
  layer: string;
  /** For wordlist blocks: "mild" (casual swear) or "severe". Undefined for other layers. */
  severity?: "mild" | "severe";
}

export interface RateLimitedEvent {
  cid?: string;
  scope: "sub" | "ip" | "room" | "watch" | "unknown";
  retryAfterMs: number;
}

export interface MutedEvent {
  cid?: string;
  /** ms until the mute expires. */
  retryAfterMs: number;
}

export interface StandingEvent {
  /** Current effective strike count (decayed, rounded). */
  strikes: number;
  /** True if the user is under heightened moderation scrutiny. */
  watch: boolean;
  /** Mute expiry (ms epoch). 0 if not muted. */
  mutedUntil: number;
}

export interface MoerantErrorEvent {
  cid?: string;
  code: string;
}

// Event map for type-safe listeners.
export interface EventMap {
  connected: WelcomeInfo;
  disconnected: { code: number; reason: string };
  message: IncomingMessage;
  join: PlayerRef;
  leave: PlayerRef;
  blocked: BlockedEvent;
  rateLimited: RateLimitedEvent;
  muted: MutedEvent;
  standing: StandingEvent;
  error: MoerantErrorEvent;
}

export type EventName = keyof EventMap;
export type Listener<E extends EventName> = (event: EventMap[E]) => void;

// ---------- Constants ----------

const PING_INTERVAL_MS = 30_000;
const TOKEN_REFRESH_LEEWAY_MS = 30_000;
const OUTBOX_MAX = 50;

// ---------- Internal types ----------

interface Session {
  token: string;
  wsUrl: string;
  matchId: string;
  expiresAt: number;
}

interface OutboxItem {
  text: string;
  cid: string;
}

// ---------- Moderant class ----------

export class Moderant {
  private session: Session | null = null;
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private outbox: OutboxItem[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private manualClose = false;
  private mint: JoinOptions["mint"] | null = null;
  private matchId: string | null = null;
  private listeners: { [K in EventName]?: Set<Listener<K>> } = {};

  /** Open a room. Connects the WebSocket. Resolves on `welcome`, rejects on fatal error. */
  async join(opts: JoinOptions): Promise<WelcomeInfo> {
    this.mint = opts.mint;
    this.matchId = opts.matchId;
    this.session = null;

    return new Promise<WelcomeInfo>((resolve, reject) => {
      const onConnected: Listener<"connected"> = (info) => {
        this.off("connected", onConnected);
        this.off("error", onError);
        resolve(info);
      };
      const onError: Listener<"error"> = (e) => {
        this.off("connected", onConnected);
        this.off("error", onError);
        reject(new Error(`join failed: ${e.code}`));
      };
      this.on("connected", onConnected);
      this.on("error", onError);
      void this.connect();
    });
  }

  /**
   * Send a chat message. Returns the correlation id (cid) you can use to
   * track its moderation outcome via `blocked`, `rateLimited`, or `message`
   * (self-echo) events.
   *
   * If the connection is dead, the SDK queues the message and lazy-reconnects.
   */
  send(text: string): string {
    if (!this.session) throw new Error("not_joined");
    if (this.outbox.length >= OUTBOX_MAX) {
      throw new Error("outbox_full");
    }
    const cid = newCid();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ t: "say", text, cid }));
        return cid;
      } catch {
        /* fall through to outbox + reconnect */
      }
    }
    this.outbox.push({ text, cid });
    void this.connect();
    return cid;
  }

  /** Close the connection and clear state. */
  leave(): void {
    this.manualClose = true;
    this.stopPings();
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close(1000, "leave");
      } catch {
        /* already closed */
      }
    }
    this.ws = null;
    this.session = null;
    this.outbox = [];
    this.matchId = null;
    this.isConnecting = false;
  }

  // ---------- Event emitter ----------

  on<E extends EventName>(event: E, listener: Listener<E>): void {
    let set = this.listeners[event] as Set<Listener<E>> | undefined;
    if (!set) {
      set = new Set<Listener<E>>();
      (this.listeners[event] as Set<Listener<E>>) = set;
    }
    set.add(listener);
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    (this.listeners[event] as Set<Listener<E>> | undefined)?.delete(listener);
  }

  private emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = this.listeners[event] as Set<Listener<E>> | undefined;
    if (!set) return;
    for (const l of set) {
      try {
        l(payload);
      } catch (err) {
        console.error(`[@moderant/web] listener for ${event} threw`, err);
      }
    }
  }

  // ---------- Connection management ----------

  private async ensureFreshToken(): Promise<void> {
    if (!this.mint || !this.matchId) throw new Error("not_joined");
    if (this.session) {
      const expMs = this.session.expiresAt * 1000;
      if (expMs > Date.now() + TOKEN_REFRESH_LEEWAY_MS) return;
    }
    const r = await this.mint(this.matchId);
    this.session = {
      token: r.token,
      wsUrl: r.wsUrl,
      matchId: r.matchId,
      expiresAt: r.expiresAt,
    };
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.isConnecting = true;

    try {
      await this.ensureFreshToken();
    } catch (err) {
      this.isConnecting = false;
      this.emit("error", { code: `mint_failed:${(err as Error).message}` });
      return;
    }

    if (!this.session) {
      this.isConnecting = false;
      return;
    }

    const socket = new WebSocket(this.session.wsUrl);
    this.ws = socket;

    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify({ t: "hello", token: this.session!.token }));
      } catch (err) {
        this.emit("error", { code: `hello_send_failed:${(err as Error).message}` });
      }
    });

    socket.addEventListener("message", (ev) => this.onServerFrame(ev));

    socket.addEventListener("close", (ev) => {
      this.stopPings();
      if (this.ws === socket) this.ws = null;
      this.isConnecting = false;
      this.emit("disconnected", { code: ev.code, reason: ev.reason });
      if (this.manualClose) {
        this.manualClose = false;
      }
    });

    socket.addEventListener("error", () => {
      /* close event will handle emission */
    });
  }

  private onServerFrame(ev: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      this.emit("error", { code: "bad_server_frame" });
      return;
    }

    const t = msg.t;
    if (t === "welcome") {
      const you = (msg.you ?? {}) as Partial<WelcomeInfo>;
      if (
        typeof you.sub !== "string" ||
        typeof you.name !== "string" ||
        typeof you.matchId !== "string"
      ) {
        this.emit("error", { code: "bad_welcome" });
        return;
      }
      this.isConnecting = false;
      this.startPings();
      this.flushOutbox();
      const info: WelcomeInfo = {
        sub: you.sub,
        name: you.name,
        matchId: you.matchId,
      };
      if (typeof you.email === "string") info.email = you.email;
      this.emit("connected", info);
      return;
    }
    if (t === "pong") return;
    if (t === "join") {
      const p = (msg.player ?? {}) as Partial<PlayerRef>;
      if (typeof p.sub === "string" && typeof p.name === "string") {
        this.emit("join", { sub: p.sub, name: p.name });
      }
      return;
    }
    if (t === "leave") {
      const p = (msg.player ?? {}) as Partial<PlayerRef>;
      if (typeof p.sub === "string" && typeof p.name === "string") {
        this.emit("leave", { sub: p.sub, name: p.name });
      }
      return;
    }
    if (t === "say") {
      const from = (msg.from ?? {}) as Partial<PlayerRef>;
      if (
        typeof from.sub !== "string" ||
        typeof from.name !== "string" ||
        typeof msg.text !== "string" ||
        typeof msg.at !== "number"
      ) {
        return;
      }
      const cid = typeof msg.cid === "string" ? msg.cid : undefined;
      this.emit("message", {
        from: { sub: from.sub, name: from.name },
        text: msg.text,
        at: msg.at,
        cid,
      });
      return;
    }
    if (t === "blocked") {
      const cid = typeof msg.cid === "string" ? msg.cid : undefined;
      const layer = typeof msg.layer === "string" ? msg.layer : "unknown";
      const severity =
        msg.severity === "mild" || msg.severity === "severe" ? msg.severity : undefined;
      this.emit("blocked", { cid, layer, severity });
      return;
    }
    if (t === "standing") {
      const strikes = typeof msg.strikes === "number" ? msg.strikes : 0;
      const watch = Boolean(msg.watch);
      const mutedUntil = typeof msg.mutedUntil === "number" ? msg.mutedUntil : 0;
      this.emit("standing", { strikes, watch, mutedUntil });
      return;
    }
    if (t === "error") {
      const cid = typeof msg.cid === "string" ? msg.cid : undefined;
      if (msg.code === "rate_limit") {
        const scope =
          msg.scope === "sub" || msg.scope === "ip" || msg.scope === "room" || msg.scope === "watch"
            ? msg.scope
            : "unknown";
        const retryAfterMs =
          typeof msg.retryAfter === "number" ? msg.retryAfter : 10_000;
        this.emit("rateLimited", { cid, scope, retryAfterMs });
      } else if (msg.code === "muted") {
        const retryAfterMs =
          typeof msg.retryAfter === "number" ? msg.retryAfter : 60_000;
        this.emit("muted", { cid, retryAfterMs });
      } else {
        this.emit("error", {
          cid,
          code: typeof msg.code === "string" ? msg.code : "unknown",
        });
      }
      return;
    }
  }

  // ---------- Keepalive ----------

  private startPings(): void {
    this.stopPings();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ t: "ping" }));
        } catch {
          /* ignore; close handler will clean up */
        }
      }
    }, PING_INTERVAL_MS);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---------- Outbox ----------

  private flushOutbox(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.outbox.length > 0) {
      const item = this.outbox.shift()!;
      try {
        this.ws.send(JSON.stringify({ t: "say", text: item.text, cid: item.cid }));
      } catch {
        this.outbox.unshift(item);
        return;
      }
    }
  }
}

// ---------- Helpers ----------

function newCid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as Crypto).randomUUID === "function"
  ) {
    return (crypto as Crypto).randomUUID();
  }
  return (
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}
