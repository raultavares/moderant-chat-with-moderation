/**
 * One simulated player. Opens a WebSocket, does the hello handshake,
 * sends messages from the corpus at randomized intervals until stopped.
 * Records per-message metrics for later aggregation.
 */

import WebSocket from "ws";
import { pickRandomMessage, pickToxicMessage, type CorpusEntry } from "./corpus.js";
import type { MintedToken } from "./mint.js";

export type MessageOutcome =
  | "confirmed"
  | "blocked"
  | "rate_limited"
  | "muted"
  | "errored"
  | "timed_out";

export interface SentMessage {
  cid: string;
  text: string;
  category: CorpusEntry["category"];
  sentAt: number;        // ms epoch
  resolvedAt?: number;   // ms epoch
  outcome?: MessageOutcome;
  latencyMs?: number;
  moderationLayer?: string;
  moderationSeverity?: string;
  rateLimitScope?: string;
  errorCode?: string;
}

export interface BotMetrics {
  sub: string;
  matchId: string;
  connected: boolean;
  connectErrorCode?: number;
  connectErrorReason?: string;
  connectLatencyMs?: number;   // open -> welcome
  standingFrames: number;      // count of `standing` frames received
  mutedAt?: number;            // ms epoch of first muted response
  messages: SentMessage[];
}

export interface BotConfig {
  token: MintedToken;
  /** min delay in ms between messages. */
  sendIntervalMinMs: number;
  /** max delay in ms between messages. */
  sendIntervalMaxMs: number;
  /** total run duration in ms. */
  durationMs: number;
  /** per-pending message timeout in ms before marking timed_out. */
  pendingTimeoutMs: number;
  /** when true, append a short random tag to each message to defeat
   *  AI Gateway cache and measure true model latency. */
  unique?: boolean;
  /** when true, send only severe-category messages (profane_slur, threat). */
  toxic?: boolean;
}

export class Bot {
  private ws: WebSocket | null = null;
  private welcomed = false;
  private stopped = false;
  private sendTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pending: Map<string, SentMessage> = new Map();
  private pendingTimers: Map<string, NodeJS.Timeout> = new Map();
  readonly metrics: BotMetrics;
  private resolveDone!: () => void;
  private donePromise: Promise<void>;

  constructor(private cfg: BotConfig) {
    this.metrics = {
      sub: cfg.token.sub,
      matchId: cfg.token.matchId,
      connected: false,
      standingFrames: 0,
      messages: [],
    };
    this.donePromise = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  /** Open the socket and run until duration elapses. Resolves with metrics. */
  async run(): Promise<BotMetrics> {
    try {
      await this.connect();
    } catch (err) {
      this.metrics.connectErrorReason = (err as Error).message;
      return this.metrics;
    }

    const endTimer = setTimeout(() => this.stop("duration_elapsed"), this.cfg.durationMs);
    this.scheduleNextSend();
    this.pingTimer = setInterval(() => this.sendPing(), 30_000);

    await this.donePromise;
    clearTimeout(endTimer);
    return this.metrics;
  }

  stop(_reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    // Finalize any still-pending messages.
    for (const m of this.pending.values()) {
      if (!m.outcome) {
        m.outcome = "timed_out";
        m.resolvedAt = Date.now();
      }
    }
    try {
      this.ws?.close(1000, "loadtest_done");
    } catch { /* ignore */ }
    this.resolveDone();
  }

  // ---- connection ----

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.token.wsUrl);
      this.ws = ws;
      let openedAt = 0;
      const openTimeout = setTimeout(() => {
        reject(new Error("open_timeout"));
      }, 15_000);

      ws.on("open", () => {
        clearTimeout(openTimeout);
        openedAt = Date.now();
        try {
          ws.send(JSON.stringify({ t: "hello", token: this.cfg.token.token }));
        } catch (err) {
          reject(new Error("hello_send_failed:" + (err as Error).message));
          return;
        }
      });

      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const msg = this.safeParse(text);
        if (!msg) return;

        if (msg.t === "welcome") {
          this.welcomed = true;
          this.metrics.connected = true;
          this.metrics.connectLatencyMs = openedAt > 0 ? Date.now() - openedAt : undefined;
          resolve();
          return;
        }
        if (msg.t === "pong") return;
        if (msg.t === "standing") {
          this.metrics.standingFrames++;
          return;
        }
        if (msg.t === "say" && typeof msg.cid === "string") {
          this.resolve(msg.cid, "confirmed");
          return;
        }
        if (msg.t === "blocked" && typeof msg.cid === "string") {
          this.resolve(msg.cid, "blocked", {
            moderationLayer: typeof msg.layer === "string" ? msg.layer : undefined,
            moderationSeverity: typeof msg.severity === "string" ? msg.severity : undefined,
          });
          return;
        }
        if (msg.t === "error") {
          const cid = typeof msg.cid === "string" ? msg.cid : null;
          if (msg.code === "rate_limit" && cid) {
            this.resolve(cid, "rate_limited", {
              rateLimitScope: typeof msg.scope === "string" ? msg.scope : undefined,
            });
            return;
          }
          if (msg.code === "muted" && cid) {
            if (!this.metrics.mutedAt) this.metrics.mutedAt = Date.now();
            this.resolve(cid, "muted");
            return;
          }
          if (cid) {
            this.resolve(cid, "errored", {
              errorCode: typeof msg.code === "string" ? msg.code : "unknown",
            });
          }
          return;
        }
      });

      ws.on("close", (code, reasonBuf) => {
        const reason = reasonBuf?.toString("utf8") ?? "";
        if (!this.welcomed) {
          clearTimeout(openTimeout);
          this.metrics.connectErrorCode = code;
          this.metrics.connectErrorReason = reason;
          reject(new Error(`close_before_welcome:${code}:${reason}`));
          return;
        }
        this.stop("ws_closed");
      });

      ws.on("error", (err) => {
        if (!this.welcomed) {
          clearTimeout(openTimeout);
          reject(err);
        }
      });
    });
  }

  // ---- send loop ----

  private scheduleNextSend(): void {
    if (this.stopped) return;
    const { sendIntervalMinMs, sendIntervalMaxMs } = this.cfg;
    const delay =
      sendIntervalMinMs +
      Math.random() * (sendIntervalMaxMs - sendIntervalMinMs);
    this.sendTimer = setTimeout(() => this.sendOne(), delay);
  }

  private sendOne(): void {
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.scheduleNextSend();
      return;
    }
    const entry = this.cfg.toxic ? pickToxicMessage() : pickRandomMessage();
    const cid = this.newCid();
    const text = this.cfg.unique
      ? `${entry.text} #${Math.random().toString(36).slice(2, 7)}`
      : entry.text;
    const sent: SentMessage = {
      cid,
      text,
      category: entry.category,
      sentAt: Date.now(),
    };
    this.pending.set(cid, sent);
    this.metrics.messages.push(sent);

    try {
      this.ws.send(JSON.stringify({ t: "say", text, cid }));
    } catch (err) {
      this.resolve(cid, "errored", { errorCode: `send_throw:${(err as Error).message}` });
      this.scheduleNextSend();
      return;
    }

    const t = setTimeout(() => {
      this.resolve(cid, "timed_out");
    }, this.cfg.pendingTimeoutMs);
    this.pendingTimers.set(cid, t);

    this.scheduleNextSend();
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ t: "ping" }));
    } catch { /* ignore */ }
  }

  // ---- helpers ----

  private resolve(
    cid: string,
    outcome: MessageOutcome,
    extra?: Partial<SentMessage>,
  ): void {
    const entry = this.pending.get(cid);
    if (!entry || entry.outcome) return;
    entry.outcome = outcome;
    entry.resolvedAt = Date.now();
    entry.latencyMs = entry.resolvedAt - entry.sentAt;
    if (extra) Object.assign(entry, extra);
    this.pending.delete(cid);
    const t = this.pendingTimers.get(cid);
    if (t) clearTimeout(t);
    this.pendingTimers.delete(cid);
  }

  private safeParse(text: string): Record<string, unknown> | null {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private newCid(): string {
    return (
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36)
    );
  }
}
