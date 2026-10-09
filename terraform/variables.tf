variable "account_id" {
  description = "Cloudflare account ID. Found in the dashboard sidebar."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for the chat hostname. Found on the zone overview page."
  type        = string
}

variable "chat_hostname" {
  description = "Public hostname for the chat WebSocket endpoint, e.g. 'chat.yourgame.com'. Must belong to the zone identified by zone_id."
  type        = string
}

variable "admin_hostname" {
  description = "Public hostname for the admin dashboard + API. Typically a subdomain like 'admin.chat.yourgame.com' or 'chat-admin.yourgame.com'. Must belong to zone_id. Put Cloudflare Access in front of this hostname in production."
  type        = string
}

variable "chat_access_bypass" {
  description = <<-EOT
    Create a Cloudflare Access application with a "Bypass, Everyone" policy on
    chat_hostname. Only needed if your account has Zero Trust "Block traffic to
    all domains in this account" turned on, which rejects any hostname that has
    no Access application. Leave false otherwise: bypass adds no protection, and
    player auth is always enforced by the chat worker's JWT check. Requires the
    "Access: Apps and Policies: Edit" token permission when true.
  EOT
  type        = bool
  default     = false
}

variable "issuers" {
  description = <<-EOT
    Games allowed to mint chat tokens. The map key is the issuer id, sent as the
    JWT `iss` claim (2-32 chars: lowercase a-z, digits, hyphens). Every game gets
    its own RS256 keypair at keys/<id>-private.pem, so a leaked key only exposes
    one game, and strikes/mutes are tracked per (game, player).

    kid (optional): JWT header key id. Defaults to "<id>-YYYY-MM", fixed at the
    game's first apply.

    Add or remove a game by editing this map and running `terraform apply`.

    Example:
      issuers = {
        "my-game"    = {}
        "other-game" = { kid = "other-game-2026-10" }
      }
  EOT
  type = map(object({
    kid = optional(string, "")
  }))

  validation {
    condition     = length(var.issuers) > 0
    error_message = "Define at least one issuer."
  }

  validation {
    condition     = alltrue([for id in keys(var.issuers) : can(regex("^[a-z0-9-]{2,32}$", id))])
    error_message = "Each issuer id must be 2-32 chars: lowercase a-z, digits, or hyphens."
  }
}

variable "clef_threshold" {
  description = "Clef unsafe probability threshold for blocking (0.0 to 1.0). 0.3 is the measured sweet spot."
  type        = string
  default     = "0.3"
}

variable "rl_per_sub" {
  description = "Rate limit per JWT subject (per user). Measured prod default: 10 per 10s."
  type = object({
    limit  = number
    period = number
  })
  default = {
    limit  = 10
    period = 10
  }
}

variable "rl_per_ip" {
  description = "Rate limit per source IP. Measured prod default: 60 per 10s. Loosen for shared-NAT populations."
  type = object({
    limit  = number
    period = number
  })
  default = {
    limit  = 60
    period = 10
  }
}

variable "rl_per_room" {
  description = "Rate limit per room (per matchId). Measured prod default: 100 per 10s."
  type = object({
    limit  = number
    period = number
  })
  default = {
    limit  = 100
    period = 10
  }
}

variable "ai_gateway_log_limit" {
  description = "Maximum number of moderation request logs the AI Gateway keeps; oldest are deleted first. Default 100000 fits the Free plan cap. Workers Paid accounts can raise it up to 10000000."
  type        = number
  default     = 100000

  validation {
    condition     = var.ai_gateway_log_limit >= 10000 && var.ai_gateway_log_limit <= 10000000
    error_message = "ai_gateway_log_limit must be between 10000 and 10000000."
  }
}

variable "load_wordlist" {
  description = "If true, download the LDNOOBW English wordlist and load it into the WORDLIST KV namespace. Set false if you plan to supply your own wordlist out of band."
  type        = bool
  default     = true
}

variable "resource_prefix" {
  description = "Prefix for all Cloudflare resource names. Change if deploying multiple moderant stacks to the same account."
  type        = string
  default     = "moderant"
}

# ---------- Discipline (M4.14) ----------

variable "mild_terms" {
  description = "Terms that, when matched by the wordlist, are tagged severity=mild. Mild blocks are still blocked, but do not count toward the user's strike total."
  type        = list(string)
  default     = ["fuck", "fucking", "fucked", "shit", "shitty", "bitch", "ass", "asshole", "bastard", "damn", "hell", "crap", "piss", "dick", "cock", "pussy", "motherfucker"]
}

variable "rl_watch" {
  description = "Tighter rate limit applied to users under heightened scrutiny (watch tier). Default: 3 per 10s (vs. 10 per 10s for normal users)."
  type = object({
    limit  = number
    period = number
  })
  default = {
    limit  = 3
    period = 10
  }
}

variable "discipline" {
  description = <<-EOT
    JSON blob of discipline policy. Keys:
      decayMsPerStrike          ms per strike forgiven (linear)
      watchPoints               effective strikes threshold for watch tier
      watchThresholdMultiplier  factor on clef_threshold for watched users (<1 = stricter)
      tiers                     [{points, muteMs}] ascending; mute applied on crossing
      weights                   {wordlistMild, wordlistSevere, clef, clefHighConf, clefHighConfAt, guardrails, unavailable}
    Leave empty to use built-in defaults.
    Default ladder: watch at 3; mute at 5=1m, 8=5m, 12=10m, 15=30m. Decay: 1 strike/hour.
  EOT
  type        = string
  default     = ""
}

