// Runtime env bindings for worker-warm. Must match the bindings block in
// terraform/main.tf (resource "cloudflare_workers_script" "warm").

interface Env {
  AI: Ai;
  AI_GATEWAY_ID: string;
}
