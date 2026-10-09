/**
 * RoomDO - one Durable Object instance per matchId.
 *
 * Extends DurableObject so admin can call it via RPC (adminRoster,
 * adminRefresh) through a cross-script namespace binding. The on-the-wire
 * class name stays "RoomDO" so no v2 migration is needed.
 *
 * Connection lifecycle:
 *   1. Worker forwards WS upgrade. Headers carry matchId + clientIp.
 *   2. DO accepts the socket, stashes an UnauthedAttachment, arms a 10s alarm.
 *   3. Client sends {"t":"hello","token":"<jwt>"}.
 *      DO verifies JWT, loads the user's discipline standing from D1
 *      (ONE round-trip), stores both on the socket, replies welcome +
 *      standing frame, broadcasts join.
 *   4. On each `say`:
 *      - mute check (standing cached on socket; cheap)
 *      - rate limits (per-sub, per-ip, per-room; plus RL_WATCH if watched)
 *      - moderation (threshold override if watched)
 *      - if blocked: send `blocked` to sender immediately, then write
 *        strike to D1, then send `standing` frame
 *      - if clean: broadcast + accumulate session counters
 *      - flush accumulated counters to D1 every 25 messages
 *   5. On close: flush pending counters.
 *
 * Hibernation: per-socket state lives in ws.serializeAttachment().
 */

import * as jose from "jose";
import { DurableObject } from "cloudflare:workers";
import {
  parseDiscipline, type DisciplineConfig,
  type ModerationResult, type Standing,
  getStanding, recordStrike, flushSession, pardonUser, manualMute,
  effectiveStrikes, scoreFor, standingFrame, emptyStanding,
} from "../../shared/discipline";

// ---------- Types ----------

type UnauthedAttachment = {
  authed: false;
  matchId: string;
  clientIp: string;
  grantedAt: number;
};

type AuthedAttachment = {
  authed: true;
  sub: string;
  name: string;
  /** Optional JWT claim. Absent when the game has no email for the player. */
  email?: string;
  matchId: string;
  clientIp: string;
  iss: string;
  joinedAt: number;
  // Cached discipline standing (refreshed on hello and on strike).
  standing: Standing;
  // Unflushed session counters.
  pendingMsgs: number;
  pendingScoreSum: number;
};

type Attachment = UnauthedAttachment | AuthedAttachment;

/**
 * TRUSTED_ISSUERS secret: JSON map of `iss` -> public key. Each value is
 * either `{ kid?, pem }` with an SPKI PEM (what Terraform emits) or an RSA JWK
 * (`{ kty: "RSA", n, e, ... }`) for hand-written configs.
 */
type PemIssuerKey = { kid?: string; pem: string };
type TrustedIssuerKey = PemIssuerKey | jose.JWK;
type TrustedIssuers = Record<string, TrustedIssuerKey>;

function isPemKey(k: TrustedIssuerKey): k is PemIssuerKey {
  return typeof (k as { pem?: unknown }).pem === "string";
}

interface ChatJwtPayload extends jose.JWTPayload {
  matchId?: unknown;
  name?: unknown;
  email?: unknown;
}

// ---------- Constants ----------

const HANDSHAKE_GRACE_MS = 10_000;
const CHAT_AUDIENCE = "moderant-chat";
const FLUSH_EVERY_N_MSGS = 25;

const CLOSE_HANDSHAKE_TIMEOUT = 4000;
const CLOSE_INVALID_HELLO = 4001;
const CLOSE_UNKNOWN_ISSUER = 4002;
const CLOSE_INVALID_TOKEN = 4003;
const CLOSE_MATCH_MISMATCH = 4004;
const CLOSE_ALREADY_HANDSHAKEN = 4005;
const CLOSE_SERVER_ERROR = 4500;

// ---------- RoomDO ----------

export class RoomDO extends DurableObject<Env> {
  private keyCache: Map<string, Promise<CryptoKey>> = new Map();
  private discipline: DisciplineConfig;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.discipline = parseDiscipline(env.DISCIPLINE);
  }

  // ------- HTTP entry: WebSocket upgrade -------

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const matchId = request.headers.get("X-GameChat-MatchId");
    if (!matchId) {
      return new Response("Missing X-GameChat-MatchId", { status: 400 });
    }

    const clientIp = request.headers.get("X-GameChat-ClientIp") ?? "unknown";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    const initial: UnauthedAttachment = {
      authed: false,
      matchId,
      clientIp,
      grantedAt: Date.now(),
    };
    server.serializeAttachment(initial);

    await this.ensureGraceAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ------- Admin RPC (called by worker-admin via cross-script binding) -------

  async adminRoster(): Promise<Array<{
    sub: string;
    name: string;
    iss: string;
    joinedAt: number;
    standing: {
      strikes: number;
      watch: boolean;
      mutedUntil: number;
      msgs: number;
      scoreSum: number;
      avgScore: number;
      blocksMild: number;
      blocksSevere: number;
    };
  }>> {
    const now = Date.now();
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.getAttachment(ws);
      if (!a?.authed) continue;
      const sessionMsgs = a.standing.msgs + a.pendingMsgs;
      const sessionSum = a.standing.scoreSum + a.pendingScoreSum;
      const sf = standingFrame(a.standing, this.discipline, now);
      out.push({
        sub: a.sub,
        name: a.name,
        iss: a.iss,
        joinedAt: a.joinedAt,
        standing: {
          strikes: sf.strikes,
          watch: sf.watch,
          mutedUntil: sf.mutedUntil,
          msgs: sessionMsgs,
          scoreSum: sessionSum,
          avgScore: sessionMsgs > 0 ? sessionSum / sessionMsgs : 0,
          blocksMild: a.standing.blocksMild,
          blocksSevere: a.standing.blocksSevere,
        },
      });
    }
    return out;
  }

  /**
   * Admin pardon or mute. Updates D1, then refreshes any live sockets for
   * (iss, sub) in this room and pushes a `standing` frame so the client
   * sees the change immediately.
   */
  async adminAction(args: {
    iss: string;
    sub: string;
    action: "pardon" | "mute";
    durationMs?: number;
  }): Promise<{ affectedSockets: number }> {
    if (args.action === "pardon") {
      await pardonUser(this.env.DB, args.iss, args.sub);
    } else {
      const dur = typeof args.durationMs === "number" && args.durationMs > 0 ? args.durationMs : 60_000;
      // Use the first live socket's name for display; empty if none.
      let name = "";
      for (const ws of this.ctx.getWebSockets()) {
        const a = this.getAttachment(ws);
        if (a?.authed && a.iss === args.iss && a.sub === args.sub) { name = a.name; break; }
      }
      await manualMute(this.env.DB, args.iss, args.sub, name, dur);
    }

    let affected = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.getAttachment(ws);
      if (!a?.authed || a.iss !== args.iss || a.sub !== args.sub) continue;
      // Flush pending, then re-read.
      if (a.pendingMsgs > 0) {
        await flushSession(this.env.DB, a.iss, a.sub, a.name, a.pendingMsgs, a.pendingScoreSum);
      }
      const fresh = await getStanding(this.env.DB, a.iss, a.sub, a.name);
      const updated: AuthedAttachment = {
        ...a,
        standing: fresh,
        pendingMsgs: 0,
        pendingScoreSum: 0,
      };
      ws.serializeAttachment(updated);
      this.safeSend(ws, JSON.stringify({
        t: "standing",
        ...standingFrame(fresh, this.discipline, Date.now()),
      }));
      affected++;
    }
    return { affectedSockets: affected };
  }

  // ------- Hibernation callbacks -------

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);

    const attachment = this.getAttachment(ws);
    if (!attachment) {
      this.safeClose(ws, CLOSE_SERVER_ERROR, "no_attachment");
      return;
    }

    if (!attachment.authed) {
      await this.handleHello(ws, text, attachment);
      return;
    }

    await this.handleAuthedMessage(ws, text, attachment);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment?.authed) return;
    // Flush pending session counters.
    if (attachment.pendingMsgs > 0) {
      try {
        await flushSession(
          this.env.DB,
          attachment.iss, attachment.sub, attachment.name,
          attachment.pendingMsgs, attachment.pendingScoreSum,
        );
      } catch (err) {
        console.warn("flushSession on close failed:", (err as Error).message);
      }
    }
    this.broadcast(
      JSON.stringify({
        t: "leave",
        player: { sub: attachment.sub, name: attachment.name },
      }),
      ws,
    );
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error", error);
  }

  // ------- Grace-window alarm -------

  private async ensureGraceAlarm(): Promise<void> {
    const target = Date.now() + HANDSHAKE_GRACE_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextDeadline: number | null = null;

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(ws);
      if (!attachment || attachment.authed) continue;

      const deadline = attachment.grantedAt + HANDSHAKE_GRACE_MS;
      if (deadline <= now) {
        this.safeClose(ws, CLOSE_HANDSHAKE_TIMEOUT, "handshake_timeout");
      } else if (nextDeadline === null || deadline < nextDeadline) {
        nextDeadline = deadline;
      }
    }

    if (nextDeadline !== null) {
      await this.ctx.storage.setAlarm(nextDeadline);
    }
  }

  // ------- Hello handshake -------

  private async handleHello(
    ws: WebSocket,
    text: string,
    attachment: UnauthedAttachment,
  ): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.safeClose(ws, CLOSE_INVALID_HELLO, "invalid_json");
      return;
    }

    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as Record<string, unknown>).t !== "hello" ||
      typeof (msg as Record<string, unknown>).token !== "string"
    ) {
      this.safeClose(ws, CLOSE_INVALID_HELLO, "invalid_hello_shape");
      return;
    }

    const token = (msg as Record<string, unknown>).token as string;

    let issuer: string;
    try {
      const payload = jose.decodeJwt(token) as ChatJwtPayload;
      if (typeof payload.iss !== "string") {
        this.safeClose(ws, CLOSE_INVALID_TOKEN, "missing_iss");
        return;
      }
      issuer = payload.iss;
    } catch {
      this.safeClose(ws, CLOSE_INVALID_TOKEN, "malformed_token");
      return;
    }

    const trusted = this.loadTrustedIssuers();
    const issuerKey = Object.hasOwn(trusted, issuer) ? trusted[issuer] : undefined;
    if (!issuerKey) {
      this.safeClose(ws, CLOSE_UNKNOWN_ISSUER, `unknown_issuer:${issuer}`);
      return;
    }

    let payload: ChatJwtPayload;
    try {
      const publicKey = await this.getPublicKey(issuer, issuerKey);
      const result = await jose.jwtVerify(token, publicKey, {
        audience: CHAT_AUDIENCE,
        issuer,
      });
      payload = result.payload as ChatJwtPayload;
    } catch (err) {
      console.warn("jwt verify failed:", (err as Error).message);
      this.safeClose(ws, CLOSE_INVALID_TOKEN, "verify_failed");
      return;
    }

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    const name = typeof payload.name === "string" ? payload.name : null;
    // email is optional: many games (guest, Steam, console) have none.
    const email =
      typeof payload.email === "string" && payload.email.length > 0
        ? payload.email
        : undefined;
    const jwtMatchId =
      typeof payload.matchId === "string" ? payload.matchId : null;
    if (!sub || !name || !jwtMatchId) {
      this.safeClose(ws, CLOSE_INVALID_TOKEN, "missing_claims");
      return;
    }

    if (jwtMatchId !== attachment.matchId) {
      this.safeClose(ws, CLOSE_MATCH_MISMATCH, "match_mismatch");
      return;
    }

    // Load standing from D1 (one round-trip).
    let standing: Standing;
    try {
      standing = await getStanding(this.env.DB, issuer, sub, name);
    } catch (err) {
      console.warn("getStanding failed, defaulting empty:", (err as Error).message);
      standing = emptyStanding(issuer, sub, name);
    }

    const authed: AuthedAttachment = {
      authed: true,
      sub, name, email,
      matchId: jwtMatchId,
      clientIp: attachment.clientIp,
      iss: issuer,
      joinedAt: Date.now(),
      standing,
      pendingMsgs: 0,
      pendingScoreSum: 0,
    };
    ws.serializeAttachment(authed);

    this.safeSend(
      ws,
      JSON.stringify({
        t: "welcome",
        you: { sub, name, email, matchId: jwtMatchId },
      }),
    );

    // Push standing frame if the user has any non-default state worth telling about.
    const sf = standingFrame(standing, this.discipline, Date.now());
    if (sf.strikes > 0 || sf.watch || sf.mutedUntil > 0) {
      this.safeSend(ws, JSON.stringify({ t: "standing", ...sf }));
    }

    this.broadcast(
      JSON.stringify({ t: "join", player: { sub, name } }),
      ws,
    );
  }

  // ------- Authed messages -------

  private async handleAuthedMessage(
    ws: WebSocket,
    text: string,
    attachment: AuthedAttachment,
  ): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg !== "object" || msg === null) {
      return;
    }

    const t = (msg as Record<string, unknown>).t;

    if (t === "ping") {
      this.safeSend(ws, JSON.stringify({ t: "pong", at: Date.now() }));
      return;
    }

    if (t !== "say" || typeof (msg as Record<string, unknown>).text !== "string") {
      return;
    }

    const body = (msg as Record<string, unknown>).text as string;
    const rawCid = (msg as Record<string, unknown>).cid;
    const cid = typeof rawCid === "string" && rawCid.length > 0 && rawCid.length <= 64
      ? rawCid
      : null;
    const clean = body.trim();
    if (clean.length === 0 || clean.length > 500) {
      return;
    }

    const now = Date.now();

    // ---- 1. Mute check (cheap, uses cached standing) ----
    if (attachment.standing.mutedUntil > now) {
      this.safeSend(ws, JSON.stringify({
        t: "error",
        code: "muted",
        retryAfter: attachment.standing.mutedUntil - now,
        cid,
      }));
      return;
    }

    const eff = effectiveStrikes(
      attachment.standing.strikes,
      attachment.standing.strikesAt,
      now,
      this.discipline,
    );
    const watched = eff >= this.discipline.watchPoints;

    // ---- 2. Rate limits ----
    const rateCheck = await this.checkRateLimits(
      attachment.sub,
      attachment.clientIp,
      attachment.matchId,
      watched,
    );
    if (!rateCheck.ok) {
      this.safeSend(
        ws,
        JSON.stringify({
          t: "error",
          code: "rate_limit",
          scope: rateCheck.scope,
          retryAfter: 10_000,
          cid,
        }),
      );
      return;
    }

    // ---- 3. Moderation (stricter threshold if watched) ----
    const threshold = watched
      ? Math.max(0.05, Math.min(1, this.discipline.watchThresholdMultiplier)) * 0.3
      : undefined;
    const mod = await this.moderate(clean, threshold);

    if (mod.decision === "block") {
      // Send blocked to sender first.
      this.safeSend(
        ws,
        JSON.stringify({
          t: "blocked",
          layer: mod.layer,
          severity: mod.severity,
          matched: mod.matched ?? [],
          cid,
        }),
      );

      // Write strike to D1, update cached standing, push standing frame.
      try {
        // Re-read current attachment to avoid clobbering a concurrent write.
        const current = this.getAttachment(ws);
        if (!current?.authed) return;
        const updated = await recordStrike(
          this.env.DB,
          current.standing,
          mod,
          current.matchId,
          this.discipline,
        );
        const after = this.getAttachment(ws);
        if (!after?.authed) return;
        const merged: AuthedAttachment = {
          ...after,
          standing: updated,
        };
        ws.serializeAttachment(merged);
        this.safeSend(ws, JSON.stringify({
          t: "standing",
          ...standingFrame(updated, this.discipline, Date.now()),
        }));
      } catch (err) {
        console.warn("recordStrike failed:", (err as Error).message);
      }
      return;
    }

    // ---- 4. Clean: broadcast, accumulate counters ----
    const outPeer = JSON.stringify({
      t: "say",
      from: { sub: attachment.sub, name: attachment.name },
      text: clean,
      at: Date.now(),
    });
    this.broadcast(outPeer, ws);

    const outSelf = JSON.stringify({
      t: "say",
      from: { sub: attachment.sub, name: attachment.name },
      text: clean,
      at: Date.now(),
      cid,
    });
    this.safeSend(ws, outSelf);

    // Accumulate session counters (sync, no await in between).
    const scoreVal = scoreFor(mod);
    const latest = this.getAttachment(ws);
    if (!latest?.authed) return;
    if (scoreVal !== null) {
      const next: AuthedAttachment = {
        ...latest,
        pendingMsgs: latest.pendingMsgs + 1,
        pendingScoreSum: latest.pendingScoreSum + scoreVal,
      };
      ws.serializeAttachment(next);

      // Periodic flush.
      if (next.pendingMsgs >= FLUSH_EVERY_N_MSGS) {
        try {
          await flushSession(
            this.env.DB,
            next.iss, next.sub, next.name,
            next.pendingMsgs, next.pendingScoreSum,
          );
          const afterFlush = this.getAttachment(ws);
          if (afterFlush?.authed) {
            const cleared: AuthedAttachment = {
              ...afterFlush,
              standing: {
                ...afterFlush.standing,
                msgs: afterFlush.standing.msgs + next.pendingMsgs,
                scoreSum: afterFlush.standing.scoreSum + next.pendingScoreSum,
                avgScore: (afterFlush.standing.msgs + next.pendingMsgs) > 0
                  ? (afterFlush.standing.scoreSum + next.pendingScoreSum)
                    / (afterFlush.standing.msgs + next.pendingMsgs)
                  : 0,
                lastSeen: Date.now(),
              },
              pendingMsgs: 0,
              pendingScoreSum: 0,
            };
            ws.serializeAttachment(cleared);
          }
        } catch (err) {
          console.warn("periodic flushSession failed:", (err as Error).message);
        }
      }
    }
  }

  private async moderate(text: string, threshold?: number): Promise<ModerationResult> {
    try {
      const body: Record<string, unknown> = { text };
      if (typeof threshold === "number") body.threshold = threshold;
      const r = await this.env.MODERATION.fetch(
        new Request("https://moderation/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      if (!r.ok) {
        console.warn("moderation check failed", r.status);
        return { decision: "block", layer: "unavailable" };
      }
      return await r.json();
    } catch (err) {
      console.warn("moderation call errored", (err as Error).message);
      return { decision: "block", layer: "unavailable" };
    }
  }

  /**
   * Check rate limiters in order. Watched users additionally pass RL_WATCH
   * before RL_PER_SUB, giving them a tighter slow-mode.
   * Short-circuits on first denial.
   */
  private async checkRateLimits(
    sub: string,
    clientIp: string,
    matchId: string,
    watched: boolean,
  ): Promise<{ ok: true } | { ok: false; scope: "sub" | "ip" | "room" | "watch" }> {
    if (watched) {
      const w = await this.env.RL_WATCH.limit({ key: sub });
      if (!w.success) return { ok: false, scope: "watch" };
    }
    const sub_ = await this.env.RL_PER_SUB.limit({ key: sub });
    if (!sub_.success) return { ok: false, scope: "sub" };

    const ip = await this.env.RL_PER_IP.limit({ key: clientIp });
    if (!ip.success) return { ok: false, scope: "ip" };

    const room = await this.env.RL_PER_ROOM.limit({ key: matchId });
    if (!room.success) return { ok: false, scope: "room" };

    return { ok: true };
  }

  // ------- Helpers -------

  private loadTrustedIssuers(): TrustedIssuers {
    const raw = this.env.TRUSTED_ISSUERS;
    if (!raw) {
      throw new Error("TRUSTED_ISSUERS secret is not set");
    }
    try {
      return JSON.parse(raw) as TrustedIssuers;
    } catch {
      throw new Error("TRUSTED_ISSUERS is not valid JSON");
    }
  }

  private getPublicKey(issuer: string, key: TrustedIssuerKey): Promise<CryptoKey> {
    let cached = this.keyCache.get(issuer);
    if (!cached) {
      cached = (isPemKey(key)
        ? jose.importSPKI(key.pem, "RS256")
        : jose.importJWK(key, "RS256")) as Promise<CryptoKey>;
      // Do not pin a failed import; let the next handshake retry.
      cached.catch(() => this.keyCache.delete(issuer));
      this.keyCache.set(issuer, cached);
    }
    return cached;
  }

  private getAttachment(ws: WebSocket): Attachment | null {
    const raw = ws.deserializeAttachment();
    if (!raw || typeof raw !== "object") return null;
    return raw as Attachment;
  }

  private broadcast(text: string, except: WebSocket | null): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const attachment = this.getAttachment(ws);
      if (!attachment?.authed) continue;
      this.safeSend(ws, text);
    }
  }

  private safeSend(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      /* already closed */
    }
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
