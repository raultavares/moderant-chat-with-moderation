output "chat_ws_url_template" {
  description = "WebSocket URL pattern. Substitute <matchId> with the room identifier."
  value       = "wss://${var.chat_hostname}/rooms/<matchId>/ws"
}

output "chat_https_base" {
  description = "HTTPS base URL for the chat worker (used for healthz)."
  value       = "https://${var.chat_hostname}"
}

output "issuers" {
  description = "Per-game JWT signing details. Each game's mint endpoint uses only its own entry. Upload the private key to that game's secret manager; never commit it."
  value = {
    for id in keys(var.issuers) : id => {
      iss              = id
      kid              = local.issuer_kids[id]
      private_key_path = local_sensitive_file.issuer_private_pem[id].filename
      public_key_path  = local_file.issuer_public_pem[id].filename
    }
  }
}

output "chat_audience" {
  description = "JWT 'aud' claim value expected by the chat worker."
  value       = "moderant-chat"
}

output "ai_gateway_id" {
  description = "AI Gateway ID for the moderation pipeline."
  value       = cloudflare_ai_gateway.moderation.id
}

output "wordlist_namespace_id" {
  description = "KV namespace ID for WORDLIST. Load additional language keys via wrangler kv key put."
  value       = cloudflare_workers_kv_namespace.wordlist.id
}

output "reputation_database_id" {
  description = "D1 database id (reputation + violations). Bound to chat and admin workers."
  value       = cloudflare_d1_database.reputation.id
}

output "admin_url" {
  description = "Admin dashboard URL. Paste the admin_token below to log in. Put Cloudflare Access in front of this hostname in production."
  value       = "https://${var.admin_hostname}/admin"
}

output "admin_token" {
  description = "Bearer token for /admin/api/*. Rotate by tainting random_password.admin_token."
  value       = random_password.admin_token.result
  sensitive   = true
}

output "smoke_test" {
  description = "Run this to verify the chat and admin workers are reachable."
  value       = "curl -sS https://${var.chat_hostname}/healthz && echo && curl -sS https://${var.admin_hostname}/admin/healthz"
}

output "mint_claims_template" {
  description = "JWT claim template per game for its /mint endpoint. All claims required unless marked optional."
  value = {
    for id in keys(var.issuers) : id => jsonencode({
      iss     = id
      aud     = "moderant-chat"
      sub     = "<stable player id>"
      name    = "<display name>"
      email   = "<optional email>"
      matchId = "<the room id the player is joining>"
      exp     = "<unix seconds; 600 to 900 recommended>"
      iat     = "<unix seconds>"
    })
  }
}

output "jwt_header_template" {
  description = "JWT header per game for its /mint endpoint."
  value = {
    for id in keys(var.issuers) : id => jsonencode({
      alg = "RS256"
      kid = local.issuer_kids[id]
      typ = "JWT"
    })
  }
}

locals {
  handoff_games = join("\n", [
    for id in sort(keys(var.issuers)) : join("\n", [
      "  ${id}",
      "    iss:           ${id}",
      "    kid:           ${local.issuer_kids[id]}",
      "    Private key:   ${local_sensitive_file.issuer_private_pem[id].filename}",
    ])
  ])
}

output "handoff" {
  description = "Everything a backend/frontend dev needs. Print with: terraform output handoff"
  value       = <<-EOT

    ============================================================
    moderant chat deployed. Hand this block to your dev team.
    ============================================================

    WebSocket URL:   wss://${var.chat_hostname}/rooms/<matchId>/ws
    Health check:    curl https://${var.chat_hostname}/healthz

    JWT signing (each game's /mint endpoint):
      Algorithm:     RS256
      aud:           moderant-chat
      Required JWT claims:
        iss, aud, sub (stable player id), name (display),
        matchId, exp (10-15 min), iat
      Optional: email

    Games (one keypair each; give a game only its own private key):
    ${local.handoff_games}

    Frontend (npm install @moderant/web):
      const chat = new Moderant();
      await chat.join({
        matchId: "<room-id>",
        mint: async (matchId) => {
          const r = await fetch("/api/chat-token?matchId=" + matchId);
          return r.json();  // { token, wsUrl, matchId, expiresAt }
        },
      });
      chat.on("message", (m) => render(m));
      chat.send("gg wp");

    Admin dashboard: https://${var.admin_hostname}/admin
      Token:         terraform output -raw admin_token
      API docs:      docs/INTEGRATE.md section 6
      Put Cloudflare Access in front of ${var.admin_hostname} in production.

    Full integration guide: docs/INTEGRATE.md

    ============================================================
    EOT
}
