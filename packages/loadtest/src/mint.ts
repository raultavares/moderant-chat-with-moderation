/**
 * Local JWT minter for the load test harness. Reads an RS256 private key
 * from disk and signs chat JWTs for synthetic bot identities.
 *
 * Config via env vars (all required unless marked optional):
 *   MODERANT_PRIVATE_KEY_PATH  absolute path to <issuer>-private.pem
 *   MODERANT_ISSUER            JWT iss claim; must match a key in TRUSTED_ISSUERS
 *   MODERANT_KID               JWT header kid; must match the issuer's JWK kid
 *   MODERANT_CHAT_WS_BASE      e.g. wss://chat.yourgame.com
 *   MODERANT_AUDIENCE          optional; default "moderant-chat"
 *
 * Convenience default: if MODERANT_PRIVATE_KEY_PATH is unset and
 * MODERANT_ISSUER is set, path is derived as ../../keys/<issuer>-private.pem
 * relative to this file (matches terraform-generated layout).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as jose from "jose";

const ISSUER = requireEnv("MODERANT_ISSUER");
const KID = requireEnv("MODERANT_KID");
const CHAT_WS_BASE = requireEnv("MODERANT_CHAT_WS_BASE");
const AUDIENCE = process.env.MODERANT_AUDIENCE ?? "moderant-chat";

const PRIVATE_KEY_PATH = process.env.MODERANT_PRIVATE_KEY_PATH ?? resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "keys", `${ISSUER}-private.pem`,
);

const TTL_SECONDS = 60 * 60; // 1 hour, long enough for load test runs

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`loadtest mint: env var ${name} is required`);
  }
  return v;
}

export interface MintedToken {
  sub: string;
  name: string;
  email: string;
  matchId: string;
  token: string;
  wsUrl: string;
  expiresAt: number;
}

let keyPromise: Promise<CryptoKey> | null = null;

async function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const pem = readFileSync(PRIVATE_KEY_PATH, "utf8");
    keyPromise = jose.importPKCS8(pem, "RS256") as Promise<CryptoKey>;
  }
  return keyPromise;
}

export async function mintBotToken(opts: {
  botIndex: number;
  matchId: string;
  /** Optional unique prefix. Keeps strikes/discipline from leaking between runs. */
  subPrefix?: string;
}): Promise<MintedToken> {
  const key = await getKey();
  const prefix = opts.subPrefix ? `${opts.subPrefix}-` : "";
  const sub = `loadtest-${prefix}bot-${String(opts.botIndex).padStart(4, "0")}`;
  const name = `bot_${String(opts.botIndex).padStart(4, "0")}`;
  const email = `${sub}@loadtest.local`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TTL_SECONDS;
  const token = await new jose.SignJWT({
    email,
    name,
    matchId: opts.matchId,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key);
  return {
    sub,
    name,
    email,
    matchId: opts.matchId,
    token,
    wsUrl: `${CHAT_WS_BASE}/rooms/${encodeURIComponent(opts.matchId)}/ws`,
    expiresAt,
  };
}

/**
 * Mint N tokens, round-robin across the given matchIds.
 */
export async function mintBotTokens(opts: {
  count: number;
  matchIds: string[];
  subPrefix?: string;
}): Promise<MintedToken[]> {
  if (opts.matchIds.length === 0) throw new Error("need at least one matchId");
  const out: MintedToken[] = [];
  for (let i = 0; i < opts.count; i++) {
    const matchId = opts.matchIds[i % opts.matchIds.length]!;
    out.push(await mintBotToken({ botIndex: i, matchId, subPrefix: opts.subPrefix }));
  }
  return out;
}
