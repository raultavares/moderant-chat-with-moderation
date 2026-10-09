// Runtime env bindings for worker-moderation. Must match the bindings block in
// terraform/main.tf (resource "cloudflare_workers_script" "moderation").

interface Env {
  AI: Ai;
  WORDLIST: KVNamespace;
  AI_GATEWAY_ID: string;
  CLEF_THRESHOLD: string;
  // JSON array of mild terms. If a wordlist block matches only mild terms,
  // the block is tagged severity="mild". Everything else is "severe".
  MILD_TERMS: string;
}
