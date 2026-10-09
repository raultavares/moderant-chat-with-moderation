# ---------- Build artifact paths ----------
#
# Terraform does not run the esbuild step; the caller is expected to have
# executed `pnpm -r build` before running `terraform apply`. The content_sha256
# forces a redeploy whenever the bundled worker changes.

locals {
  chat_bundle       = "${path.module}/../worker-chat/dist/worker.js"
  moderation_bundle = "${path.module}/../worker-moderation/dist/worker.js"
  warm_bundle       = "${path.module}/../worker-warm/dist/worker.js"
  admin_bundle      = "${path.module}/../worker-admin/dist/worker.js"
}

# ---------- Admin bearer token (random, surfaced via sensitive output) ----------

resource "random_password" "admin_token" {
  length  = 48
  special = false # keep URL/CLI safe
}

# ---------- Per-game keypairs for signing chat JWTs ----------
#
# One RS256 keypair per entry in var.issuers. The private key is written to
# keys/<id>-private.pem for that game's backend; the public key goes into the
# chat worker's TRUSTED_ISSUERS secret as an SPKI PEM (the worker imports it
# with jose.importSPKI, so no JWK conversion step is needed).

resource "time_static" "issuer_kid" {
  for_each = var.issuers
}

locals {
  issuer_kids = {
    for id, cfg in var.issuers :
    id => cfg.kid != "" ? cfg.kid : "${id}-${formatdate("YYYY-MM", time_static.issuer_kid[id].rfc3339)}"
  }
}

resource "tls_private_key" "issuer" {
  for_each  = var.issuers
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "local_sensitive_file" "issuer_private_pem" {
  for_each        = var.issuers
  filename        = "${path.module}/../keys/${each.key}-private.pem"
  content         = tls_private_key.issuer[each.key].private_key_pem_pkcs8
  file_permission = "0600"
}

resource "local_file" "issuer_public_pem" {
  for_each        = var.issuers
  filename        = "${path.module}/../keys/${each.key}-public.pem"
  content         = tls_private_key.issuer[each.key].public_key_pem
  file_permission = "0644"
}

# ---------- Account script inventory (used to decide if DO bootstrap is needed) ----------
#
# Durable Object migrations require different payloads on first-ever create vs
# every subsequent update, and the CF Terraform provider does not reconcile
# this for us. See https://github.com/cloudflare/terraform-provider-cloudflare/issues/5701.
# Fully declarative fix: list scripts on the account; if moderant-chat is not
# present, treat the apply as a first bootstrap. Zero flags, zero manual steps.
data "cloudflare_workers_scripts" "account" {
  account_id = var.account_id
}

locals {
  chat_script_name = "${var.resource_prefix}-chat"
  chat_bootstrapped = length([
    for s in data.cloudflare_workers_scripts.account.result : s.id
    if s.id == local.chat_script_name
  ]) > 0
}

# ---------- KV namespace ----------

resource "cloudflare_workers_kv_namespace" "wordlist" {
  account_id = var.account_id
  title      = "${var.resource_prefix}-wordlist"
}

# ---------- AI Gateway ----------

resource "cloudflare_ai_gateway" "moderation" {
  account_id                 = var.account_id
  id                         = "${var.resource_prefix}-moderation"
  cache_ttl                  = 3600
  cache_invalidate_on_update = true
  collect_logs               = true
  authentication             = false
  rate_limiting_interval     = 0
  rate_limiting_limit        = 0
  log_management             = var.ai_gateway_log_limit
  log_management_strategy    = "DELETE_OLDEST"
}

# ---------- D1 database (discipline: reputation + violations) ----------

resource "cloudflare_d1_database" "reputation" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-reputation"

  read_replication = {
    mode = "auto"
  }
}

# ---------- Workers ----------

# moderation worker: no bindings except AI, KV, and env vars.
resource "cloudflare_workers_script" "moderation" {
  account_id          = var.account_id
  script_name         = "${var.resource_prefix}-moderation"
  content_file        = local.moderation_bundle
  content_sha256      = filesha256(local.moderation_bundle)
  main_module         = "worker.js"
  compatibility_date  = "2026-05-01"
  compatibility_flags = ["nodejs_compat"]

  observability = {
    enabled = true
  }

  bindings = [
    {
      name = "AI"
      type = "ai"
    },
    {
      name         = "WORDLIST"
      type         = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.wordlist.id
    },
    {
      name = "AI_GATEWAY_ID"
      type = "plain_text"
      text = cloudflare_ai_gateway.moderation.id
    },
    {
      name = "CLEF_THRESHOLD"
      type = "plain_text"
      text = var.clef_threshold
    },
    {
      name = "MILD_TERMS"
      type = "plain_text"
      text = jsonencode(var.mild_terms)
    },
  ]

  # Provider v5 drifts on observability (CF server-side defaults).
  lifecycle {
    ignore_changes = [observability]
  }
}

# warm worker: AI binding + gateway id var.
resource "cloudflare_workers_script" "warm" {
  account_id         = var.account_id
  script_name        = "${var.resource_prefix}-warm"
  content_file       = local.warm_bundle
  content_sha256     = filesha256(local.warm_bundle)
  main_module        = "worker.js"
  compatibility_date = "2026-10-02"

  observability = {
    enabled = true
  }

  bindings = [
    {
      name = "AI"
      type = "ai"
    },
    {
      name = "AI_GATEWAY_ID"
      type = "plain_text"
      text = cloudflare_ai_gateway.moderation.id
    },
  ]

  lifecycle {
    ignore_changes = [observability]
  }
}

# chat worker: service bindings to moderation+warm, 3 rate limits, DO, secret.
resource "cloudflare_workers_script" "chat" {
  account_id          = var.account_id
  script_name         = "${var.resource_prefix}-chat"
  content_file        = local.chat_bundle
  content_sha256      = filesha256(local.chat_bundle)
  main_module         = "worker.js"
  compatibility_date  = "2026-05-01"
  compatibility_flags = ["nodejs_compat"]

  observability = {
    enabled = true
  }

  # DO migration shape is picked automatically based on whether the script
  # already exists on the account (see local.chat_bootstrapped):
  #   - Not present: initial create with new_sqlite_classes.
  #   - Present:     steady-state with old_tag.
  # Then `migrations` is in ignore_changes so provider drift (CF-5701) does
  # not re-trigger an update on every plan. Fully declarative, zero flags.
  migrations = local.chat_bootstrapped ? {
    old_tag            = "v1"
    new_tag            = "v1"
    new_sqlite_classes = null
    } : {
    old_tag            = null
    new_tag            = "v1"
    new_sqlite_classes = ["RoomDO"]
  }

  lifecycle {
    ignore_changes = [
      observability,
      migrations,
    ]
  }

  bindings = [
    {
      name       = "ROOM"
      type       = "durable_object_namespace"
      class_name = "RoomDO"
    },
    {
      name    = "MODERATION"
      type    = "service"
      service = cloudflare_workers_script.moderation.script_name
    },
    {
      name    = "WARM"
      type    = "service"
      service = cloudflare_workers_script.warm.script_name
    },
    {
      name = "TRUSTED_ISSUERS"
      type = "secret_text"
      text = jsonencode({
        for id in keys(var.issuers) : id => {
          kid = local.issuer_kids[id]
          pem = tls_private_key.issuer[id].public_key_pem
        }
      })
    },
    {
      name         = "RL_PER_SUB"
      type         = "ratelimit"
      namespace_id = "1001"
      simple = {
        limit  = var.rl_per_sub.limit
        period = var.rl_per_sub.period
      }
    },
    {
      name         = "RL_PER_IP"
      type         = "ratelimit"
      namespace_id = "1002"
      simple = {
        limit  = var.rl_per_ip.limit
        period = var.rl_per_ip.period
      }
    },
    {
      name         = "RL_PER_ROOM"
      type         = "ratelimit"
      namespace_id = "1003"
      simple = {
        limit  = var.rl_per_room.limit
        period = var.rl_per_room.period
      }
    },
    {
      name         = "RL_WATCH"
      type         = "ratelimit"
      namespace_id = "1004"
      simple = {
        limit  = var.rl_watch.limit
        period = var.rl_watch.period
      }
    },
    {
      name        = "DB"
      type        = "d1"
      database_id = cloudflare_d1_database.reputation.id
    },
    {
      name = "DISCIPLINE"
      type = "plain_text"
      text = var.discipline
    },
  ]
}

# ---------- Admin worker (dashboard + ranking + pardon/mute) ----------

resource "cloudflare_workers_script" "admin" {
  account_id          = var.account_id
  script_name         = "${var.resource_prefix}-admin"
  content_file        = local.admin_bundle
  content_sha256      = filesha256(local.admin_bundle)
  main_module         = "worker.js"
  compatibility_date  = "2026-05-01"
  compatibility_flags = ["nodejs_compat"]

  observability = {
    enabled = true
  }

  bindings = [
    {
      name        = "DB"
      type        = "d1"
      database_id = cloudflare_d1_database.reputation.id
    },
    {
      # Cross-script DO: admin reaches into chat's RoomDO for live roster + pardon.
      name        = "ROOM"
      type        = "durable_object_namespace"
      class_name  = "RoomDO"
      script_name = cloudflare_workers_script.chat.script_name
    },
    {
      name = "ADMIN_TOKEN"
      type = "secret_text"
      text = random_password.admin_token.result
    },
    {
      name = "DISCIPLINE"
      type = "plain_text"
      text = var.discipline
    },
  ]

  lifecycle {
    ignore_changes = [observability]
  }
}

# ---------- Custom domain for admin ----------
#
# Dedicated subdomain. Cloudflare does NOT let a Workers Route attach to a
# hostname already claimed by a Workers Custom Domain (architectural limit, not
# a token-scope limit). So admin gets its own hostname. Pattern: pick something
# like admin.<chat_hostname> or <chat>-admin.<zone>. Put Cloudflare Access in
# front in production; the API itself is bearer-token protected.
resource "cloudflare_workers_custom_domain" "admin" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.admin_hostname
  service    = cloudflare_workers_script.admin.script_name
}

# ---------- Custom domain for chat ----------

resource "cloudflare_workers_custom_domain" "chat" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.chat_hostname
  service    = cloudflare_workers_script.chat.script_name
}

# ---------- Access: public chat (optional) ----------
#
# Only created when var.chat_access_bypass = true. Accounts with Zero Trust
# "Block traffic to all domains in this account" (deny_unmatched_requests)
# reject any hostname that is not covered by an Access application. Chat is a
# public game service, so on those accounts we attach an Access application
# whose only policy is "Bypass, Everyone". That satisfies the deny gate without
# challenging players. Per-player auth is always enforced by the chat Worker
# via the game-signed JWT.

resource "cloudflare_zero_trust_access_policy" "chat_public" {
  count      = var.chat_access_bypass ? 1 : 0
  account_id = var.account_id
  name       = "${var.resource_prefix}-chat-public"
  decision   = "bypass"
  include = [
    { everyone = {} },
  ]
}

resource "cloudflare_zero_trust_access_application" "chat" {
  count                = var.chat_access_bypass ? 1 : 0
  account_id           = var.account_id
  name                 = "${var.resource_prefix}-chat"
  type                 = "self_hosted"
  domain               = var.chat_hostname
  app_launcher_visible = false
  destinations = [
    { type = "public", uri = var.chat_hostname },
  ]
  policies = [
    { id = cloudflare_zero_trust_access_policy.chat_public[0].id, precedence = 1 },
  ]
}

# Deploys created before chat_access_bypass existed had these as single
# resources. Keep them in place instead of destroying and recreating.
moved {
  from = cloudflare_zero_trust_access_policy.chat_public
  to   = cloudflare_zero_trust_access_policy.chat_public[0]
}

moved {
  from = cloudflare_zero_trust_access_application.chat
  to   = cloudflare_zero_trust_access_application.chat[0]
}

# ---------- Default wordlist (optional) ----------

data "http" "ldnoobw" {
  count = var.load_wordlist ? 1 : 0
  url   = "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en"
}

locals {
  wordlist_json = var.load_wordlist ? jsonencode([
    for line in split("\n", data.http.ldnoobw[0].response_body) :
    trimspace(line) if trimspace(line) != ""
  ]) : ""
}

resource "cloudflare_workers_kv" "wordlist_en" {
  count        = var.load_wordlist ? 1 : 0
  account_id   = var.account_id
  namespace_id = cloudflare_workers_kv_namespace.wordlist.id
  key_name     = "en"
  value        = local.wordlist_json
}
