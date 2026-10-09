// Runtime env bindings for worker-chat. Must match the bindings block in
// terraform/main.tf (resource "cloudflare_workers_script" "chat").

interface Env {
  // Durable Object
  ROOM: DurableObjectNamespace;

  // Service bindings
  MODERATION: Fetcher;
  WARM: Fetcher;

  // Secret: {"<iss>": {"kid": "...", "pem": "<SPKI PEM>"} | <RSA JWK>, ...} JSON string.
  // One entry per game allowed to mint chat tokens.
  TRUSTED_ISSUERS: string;

  // Rate limiters
  RL_PER_SUB: RateLimit;
  RL_PER_IP: RateLimit;
  RL_PER_ROOM: RateLimit;
  // Tighter rate limit applied only to watched users on top of RL_PER_SUB.
  RL_WATCH: RateLimit;

  // D1 database for discipline (reputation, violations)
  DB: D1Database;

  // JSON discipline config (ladder, decay, weights). Falls back to defaults.
  DISCIPLINE: string;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
