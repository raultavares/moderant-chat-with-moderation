/**
 * moderant admin Worker.
 *
 * Routes (all under /admin):
 *   GET  /admin                              -> HTML dashboard
 *   GET  /admin/healthz                      -> liveness
 *   GET  /admin/api/offenders?order=&min_msgs=&limit=
 *   GET  /admin/api/rooms/:matchId           -> live roster + per-user standing
 *   GET  /admin/api/users/:iss/:sub          -> standing + last N violations
 *   POST /admin/api/users/:iss/:sub/pardon   -> body { matchId? }
 *   POST /admin/api/users/:iss/:sub/mute     -> body { matchId?, durationMs }
 *
 * All /admin/api/* require Authorization: Bearer <ADMIN_TOKEN>. Timing-safe
 * compare. Dashboard HTML is public (contains no secrets).
 *
 * Live effects: when a POST includes matchId, we call the RoomDO via RPC so
 * the change is reflected on open sockets immediately (standing frame pushed).
 * Without matchId, D1 is updated and the change applies on the user's next
 * connect.
 */

import {
  getStanding, listOffenders, listViolations, pardonUser, manualMute,
  parseDiscipline,
} from "../../shared/discipline";
import { DASHBOARD_HTML } from "./dashboard";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/admin" || p === "/admin/") {
      return new Response(DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (p === "/admin/healthz" && request.method === "GET") {
      return Response.json({ ok: true, service: "moderant-admin", version: "0.1.0" });
    }

    if (!p.startsWith("/admin/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // Auth for all /admin/api/*
    if (!authorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }

    // Routes
    if (p === "/admin/api/offenders" && request.method === "GET") {
      return handleOffenders(url, env);
    }

    const roomMatch = p.match(/^\/admin\/api\/rooms\/([^/]+)$/);
    if (roomMatch && request.method === "GET") {
      return handleRoomRoster(decodeURIComponent(roomMatch[1]!), env);
    }

    const userActionMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/([^/]+)\/(pardon|mute)$/);
    if (userActionMatch && request.method === "POST") {
      return handleUserAction(
        decodeURIComponent(userActionMatch[1]!),
        decodeURIComponent(userActionMatch[2]!),
        userActionMatch[3] as "pardon" | "mute",
        request,
        env,
      );
    }

    const userMatch = p.match(/^\/admin\/api\/users\/([^/]+)\/([^/]+)$/);
    if (userMatch && request.method === "GET") {
      return handleUserDetail(
        decodeURIComponent(userMatch[1]!),
        decodeURIComponent(userMatch[2]!),
        env,
      );
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------- Auth ----------

function authorized(request: Request, env: Env): boolean {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return timingSafeEqual(m[1]!, env.ADMIN_TOKEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------- Handlers ----------

async function handleOffenders(url: URL, env: Env): Promise<Response> {
  const orderRaw = url.searchParams.get("order") || "avg";
  const order: "avg" | "strikes" | "blocks" =
    orderRaw === "strikes" ? "strikes" : orderRaw === "blocks" ? "blocks" : "avg";
  const minMsgs = Math.max(0, parseInt(url.searchParams.get("min_msgs") || "20", 10));
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "50", 10)));
  const offenders = await listOffenders(env.DB, order, minMsgs, limit);
  return Response.json({ offenders, order, minMsgs, limit });
}

async function handleUserDetail(iss: string, sub: string, env: Env): Promise<Response> {
  const standing = await getStanding(env.DB, iss, sub, "");
  const violations = await listViolations(env.DB, iss, sub, 50);
  return Response.json({ standing, violations });
}

async function handleRoomRoster(matchId: string, env: Env): Promise<Response> {
  // Cross-script DO call. idFromName must use the SAME string the chat worker
  // uses (matchId) so we hit the same DO instance.
  const id = env.ROOM.idFromName(matchId);
  const stub = env.ROOM.get(id);
  try {
    const roster = await stub.adminRoster();
    // Enrich with iss (adminRoster already includes it). Nothing else needed.
    return Response.json({ matchId, roster });
  } catch (err) {
    return Response.json(
      { error: "roster_failed", message: (err as Error).message, matchId, roster: [] },
      { status: 502 },
    );
  }
}

async function handleUserAction(
  iss: string,
  sub: string,
  action: "pardon" | "mute",
  request: Request,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown> = {};
  if (request.headers.get("content-type")?.includes("json")) {
    try { body = await request.json() as Record<string, unknown>; } catch { /* ignore */ }
  }
  const matchId = typeof body.matchId === "string" && body.matchId.length > 0 ? body.matchId : null;
  const durationMs = typeof body.durationMs === "number" && body.durationMs > 0 ? body.durationMs : 5 * 60 * 1000;

  if (matchId) {
    // Live path: let the DO update D1 AND push `standing` to open sockets.
    const id = env.ROOM.idFromName(matchId);
    const stub = env.ROOM.get(id);
    try {
      const r = await stub.adminAction({ iss, sub, action, durationMs });
      return Response.json({ ok: true, applied: "live", affectedSockets: r.affectedSockets });
    } catch (err) {
      // Fall through to D1-only path if the DO call fails.
      console.warn("adminAction RPC failed, falling back:", (err as Error).message);
    }
  }

  // D1-only path: effect applies on next connect.
  if (action === "pardon") {
    await pardonUser(env.DB, iss, sub);
  } else {
    await manualMute(env.DB, iss, sub, "", durationMs);
  }
  // Discipline is referenced to confirm the module is loaded correctly; otherwise unused here.
  parseDiscipline(env.DISCIPLINE);
  return Response.json({ ok: true, applied: "d1-only" });
}
