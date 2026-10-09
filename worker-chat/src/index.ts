/**
 * moderant chat Worker - entrypoint.
 *
 * Routes:
 *   POST /rooms              → stub, returns { ok, matchId }. Real auth in later M.
 *   GET  /rooms/:id/ws       → WebSocket upgrade, forwarded to the RoomDO.
 *   GET  /healthz            → liveness probe.
 *
 * The Worker is intentionally thin: it routes and forwards. All real work
 * (JWT verify, broadcast, presence) happens inside the Durable Object.
 *
 * Auth model (M2.5):
 *   • The Worker does NOT verify JWTs. It only forwards the upgrade to the
 *     correct RoomDO (keyed by matchId from the URL).
 *   • The RoomDO expects the client to send `{"t":"hello","token":"<jwt>"}`
 *     as the FIRST frame. The DO verifies the JWT against TRUSTED_ISSUERS,
 *     checks that jwt.matchId matches the URL's matchId, and only then
 *     treats the socket as authenticated.
 *   • Sockets that don't send hello within 10 seconds are closed (code 4000).
 *
 * We pass the URL matchId to the DO via an internal header
 * `X-GameChat-MatchId`. The DO stashes it on the socket's hibernation
 * attachment so it survives eviction and can be compared to jwt.matchId
 * at hello time.
 */

export { RoomDO } from "./room";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({
        ok: true,
        service: "moderant-chat",
        version: "0.1.0",
      });
    }

    if (url.pathname === "/rooms" && request.method === "POST") {
      return handleCreateRoom(request);
    }

    const wsMatch = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
    if (wsMatch && request.method === "GET") {
      const matchId = decodeURIComponent(wsMatch[1]);
      // Fire-and-forget warm-up to keep Workers AI GPUs hot. Not awaited.
      // Fails silently if WARM is down; chat upgrade proceeds either way.
      ctx.waitUntil(fireWarmup(env));
      return handleWebSocket(request, env, matchId);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function fireWarmup(env: Env): Promise<void> {
  try {
    await env.WARM.fetch(
      new Request("https://warm/warm", { method: "POST" }),
    );
  } catch (err) {
    console.warn("warm fire failed:", (err as Error).message);
  }
}

async function handleCreateRoom(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const matchId =
    typeof body === "object" && body !== null && "matchId" in body
      ? String((body as Record<string, unknown>).matchId)
      : null;

  if (!matchId) {
    return Response.json({ error: "missing_matchId" }, { status: 400 });
  }

  return Response.json({ ok: true, matchId });
}

/**
 * Forward a WebSocket upgrade to the correct RoomDO.
 *
 * idFromName(matchId) deterministically hashes the matchId to a DO ID, so
 * every client using the same matchId lands on the same DO instance.
 *
 * We clone the request to inject two internal headers that the DO stashes
 * on the per-socket attachment:
 *   • X-GameChat-MatchId   - the expected matchId (cross-check vs jwt.matchId)
 *   • X-GameChat-ClientIp  - the real client IP (for per-IP rate limiting)
 *
 * The client IP comes from `cf-connecting-ip`, which Cloudflare sets at the
 * edge. We prefer it over inspecting the request's remote address because
 * the request has already been proxied inside Cloudflare by the time it
 * reaches our Worker.
 */
function handleWebSocket(
  request: Request,
  env: Env,
  matchId: string,
): Promise<Response> {
  const id = env.ROOM.idFromName(matchId);
  const stub = env.ROOM.get(id);

  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";

  const forwarded = new Request(request, {
    headers: new Headers(request.headers),
  });
  forwarded.headers.set("X-GameChat-MatchId", matchId);
  forwarded.headers.set("X-GameChat-ClientIp", clientIp);

  return stub.fetch(forwarded);
}
