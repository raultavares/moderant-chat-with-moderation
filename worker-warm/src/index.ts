/**
 * moderant-warm - keeps Workers AI GPUs warm for the moderation pipeline.
 *
 * No public hostname. Service-binding only.
 * Called fire-and-forget from worker-chat on every WebSocket upgrade.
 *
 * Fires tiny parallel calls to Clef + Llama Guard through the shared
 * `moderant-moderation` AI Gateway so both models' GPU allocations stay hot.
 *
 * To unplug: remove the WARM service binding from worker-chat and redeploy.
 */

const WARM_TEXT = "ok";

const WARM_CLEF_INSTRUCTIONS = "is this message unsafe? reply with a probability.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true, service: "moderant-warm" });
    }

    if (url.pathname === "/warm" && request.method === "POST") {
      ctx.waitUntil(runWarmup(env));
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function runWarmup(env: Env): Promise<void> {
  const started = Date.now();
  const results = await Promise.allSettled([
    env.AI.run(
      "@cf/cloudflare/clef" as never,
      {
        model: "clef",
        state: WARM_TEXT,
        questions: {
          unsafe: { type: "noul", instructions: WARM_CLEF_INSTRUCTIONS },
        },
      } as never,
      { gateway: { id: env.AI_GATEWAY_ID } },
    ),
    env.AI.run(
      "@cf/meta/llama-guard-3-8b" as never,
      { messages: [{ role: "user", content: WARM_TEXT }] } as never,
      { gateway: { id: env.AI_GATEWAY_ID } },
    ),
  ]);

  const clefOk = results[0]!.status === "fulfilled";
  const llamaOk = results[1]!.status === "fulfilled";
  console.log(
    `warm done in ${Date.now() - started}ms clef=${clefOk ? "ok" : "err"} llama=${llamaOk ? "ok" : "err"}`,
  );
}
