/**
 * Discipline primitives shared by worker-chat and worker-admin.
 *
 * - D1 schema (reputation, violations) and lazy ensureSchema().
 * - Policy types: DisciplineConfig (ladder, decay, weights, threshold multiplier).
 * - Pure functions: scoreFor, weightFor, effectiveStrikes, penaltyFor.
 *
 * Both workers bundle this module via esbuild; it is not published to npm.
 */

// ---------- Moderation payload (mirror of worker-moderation response) ----------

export type ModDecision = "clean" | "block";
export type ModLayer = "wordlist" | "clef" | "guardrails" | "unavailable";
export type ModSeverity = "mild" | "severe";

export interface ModerationResult {
  decision: ModDecision;
  layer: ModLayer;
  severity?: ModSeverity;
  matched?: string[];
  categories?: string[];
  score?: number;
}

// ---------- Policy config ----------

/**
 * Ladder tier. `points` = required effective strikes; `muteMs` = mute duration
 * applied when the tier is crossed. Tiers are evaluated in ascending order; the
 * highest-matching tier wins. Watch (closer scrutiny) is NOT in the ladder, it's
 * a separate `watchPoints` threshold.
 */
export interface MuteTier {
  points: number;
  muteMs: number;
}

export interface DisciplineConfig {
  /** Linear decay: forgive one strike per this many ms. */
  decayMsPerStrike: number;
  /** Effective strikes >= this => watch (stricter threshold + slow mode). */
  watchPoints: number;
  /** Clef threshold multiplier applied to watched users (< 1 => stricter). */
  watchThresholdMultiplier: number;
  /** Mute ladder, ascending by points. */
  tiers: MuteTier[];
  /** Weights per outcome. */
  weights: {
    wordlistMild: number;
    wordlistSevere: number;
    clef: number;
    clefHighConf: number;
    clefHighConfAt: number; // score >= this => clefHighConf weight
    guardrails: number;
    unavailable: number;
  };
}

export const DEFAULT_DISCIPLINE: DisciplineConfig = {
  decayMsPerStrike: 60 * 60 * 1000, // 1 strike per hour
  watchPoints: 3,
  watchThresholdMultiplier: 0.5, // 0.30 -> 0.15
  tiers: [
    { points: 5, muteMs: 1 * 60 * 1000 },   // 1m
    { points: 8, muteMs: 5 * 60 * 1000 },   // 5m
    { points: 12, muteMs: 10 * 60 * 1000 }, // 10m
    { points: 15, muteMs: 30 * 60 * 1000 }, // 30m
  ],
  weights: {
    wordlistMild: 0,
    wordlistSevere: 2,
    clef: 1,
    clefHighConf: 2,
    clefHighConfAt: 0.8,
    guardrails: 1,
    unavailable: 0,
  },
};

export function parseDiscipline(json: string | undefined): DisciplineConfig {
  if (!json) return DEFAULT_DISCIPLINE;
  try {
    const parsed = JSON.parse(json) as Partial<DisciplineConfig>;
    return {
      ...DEFAULT_DISCIPLINE,
      ...parsed,
      weights: { ...DEFAULT_DISCIPLINE.weights, ...(parsed.weights ?? {}) },
      tiers: (parsed.tiers ?? DEFAULT_DISCIPLINE.tiers).slice().sort((a, b) => a.points - b.points),
    };
  } catch {
    return DEFAULT_DISCIPLINE;
  }
}

// ---------- Scoring / weighting ----------

/**
 * Profanity score in [0, 1]. Clean messages score 0. Unavailable / muted / rate-
 * limited paths return null (do not count toward the user's average).
 */
export function scoreFor(result: ModerationResult): number | null {
  if (result.layer === "unavailable") return null;
  if (result.decision === "clean") {
    return typeof result.score === "number" ? Math.max(0, Math.min(1, result.score)) : 0;
  }
  // block
  if (result.layer === "wordlist") {
    return result.severity === "mild" ? 0.5 : 1.0;
  }
  if (result.layer === "clef") {
    return typeof result.score === "number" ? Math.max(0, Math.min(1, result.score)) : 1.0;
  }
  if (result.layer === "guardrails") return 1.0;
  return null;
}

export function weightFor(result: ModerationResult, cfg: DisciplineConfig): number {
  if (result.decision !== "block") return 0;
  const w = cfg.weights;
  if (result.layer === "wordlist") {
    return result.severity === "mild" ? w.wordlistMild : w.wordlistSevere;
  }
  if (result.layer === "clef") {
    const s = typeof result.score === "number" ? result.score : 1.0;
    return s >= w.clefHighConfAt ? w.clefHighConf : w.clef;
  }
  if (result.layer === "guardrails") return w.guardrails;
  if (result.layer === "unavailable") return w.unavailable;
  return 0;
}

// ---------- Decay + ladder ----------

/**
 * Linear decay of the stored strike count. Lazy: compute at read time.
 * Never returns negative. `stored` is the strikes count at `storedAt`; `now`
 * is the current ms epoch.
 */
export function effectiveStrikes(
  stored: number,
  storedAt: number,
  now: number,
  cfg: DisciplineConfig,
): number {
  if (stored <= 0) return 0;
  const elapsed = Math.max(0, now - storedAt);
  const decayed = elapsed / cfg.decayMsPerStrike;
  return Math.max(0, stored - decayed);
}

/**
 * Given the user's effective strikes AFTER adding this violation, return the
 * mute tier they just crossed (if any). We only mute when the new tier is
 * strictly higher than the previous tier the user had been muted at, so
 * repeated violations at the same point total don't re-mute.
 */
export function penaltyFor(
  effectiveStrikesNow: number,
  prevMuteTierPoints: number,
  cfg: DisciplineConfig,
): MuteTier | null {
  let hit: MuteTier | null = null;
  for (const tier of cfg.tiers) {
    if (effectiveStrikesNow >= tier.points) hit = tier;
  }
  if (!hit) return null;
  if (hit.points <= prevMuteTierPoints) return null;
  return hit;
}

// ---------- Standing (per-user discipline snapshot) ----------

export interface Standing {
  iss: string;
  sub: string;
  name: string;
  msgs: number;
  scoreSum: number;
  avgScore: number;
  blocksMild: number;
  blocksSevere: number;
  strikes: number;
  strikesAt: number;
  prevMuteTier: number; // highest tier.points the user has been muted at
  mutes: number;
  mutedUntil: number;
  lastSeen: number;
}

export function emptyStanding(iss: string, sub: string, name: string): Standing {
  const now = Date.now();
  return {
    iss, sub, name,
    msgs: 0, scoreSum: 0, avgScore: 0,
    blocksMild: 0, blocksSevere: 0,
    strikes: 0, strikesAt: now, prevMuteTier: 0,
    mutes: 0, mutedUntil: 0,
    lastSeen: now,
  };
}

/** Snapshot sent to clients in `standing` frames. Never includes PII beyond name/sub. */
export interface StandingFrame {
  strikes: number;      // effective, rounded
  watch: boolean;
  mutedUntil: number;   // 0 if not muted
}

export function standingFrame(s: Standing, cfg: DisciplineConfig, now: number): StandingFrame {
  const eff = effectiveStrikes(s.strikes, s.strikesAt, now, cfg);
  return {
    strikes: Math.round(eff),
    watch: eff >= cfg.watchPoints,
    mutedUntil: s.mutedUntil > now ? s.mutedUntil : 0,
  };
}

// ---------- D1 schema + queries ----------

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS reputation (
    iss TEXT NOT NULL,
    sub TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    msgs INTEGER NOT NULL DEFAULT 0,
    score_sum REAL NOT NULL DEFAULT 0,
    blocks_mild INTEGER NOT NULL DEFAULT 0,
    blocks_severe INTEGER NOT NULL DEFAULT 0,
    strikes REAL NOT NULL DEFAULT 0,
    strikes_at INTEGER NOT NULL DEFAULT 0,
    prev_mute_tier INTEGER NOT NULL DEFAULT 0,
    mutes INTEGER NOT NULL DEFAULT 0,
    muted_until INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (iss, sub)
  )`,
  `CREATE INDEX IF NOT EXISTS reputation_strikes ON reputation (strikes DESC)`,
  `CREATE INDEX IF NOT EXISTS reputation_avg ON reputation ((CASE WHEN msgs > 0 THEN score_sum / msgs ELSE 0 END) DESC)`,
  `CREATE TABLE IF NOT EXISTS violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iss TEXT NOT NULL,
    sub TEXT NOT NULL,
    at INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    layer TEXT NOT NULL,
    severity TEXT,
    score REAL,
    matched TEXT,
    weight REAL NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS violations_user ON violations (iss, sub, at DESC)`,
];

let schemaReadyFor: WeakSet<D1Database> = new WeakSet();

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReadyFor.has(db)) return;
  for (const sql of SCHEMA_SQL) {
    await db.prepare(sql).run();
  }
  schemaReadyFor.add(db);
}

/** Fetch a user's standing. Returns an empty standing if row doesn't exist. */
export async function getStanding(
  db: D1Database,
  iss: string,
  sub: string,
  name: string,
): Promise<Standing> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      `SELECT iss, sub, name, msgs, score_sum, blocks_mild, blocks_severe,
              strikes, strikes_at, prev_mute_tier, mutes, muted_until, last_seen
       FROM reputation WHERE iss = ?1 AND sub = ?2`,
    )
    .bind(iss, sub)
    .first<Record<string, unknown>>();
  if (!row) return emptyStanding(iss, sub, name);
  const msgs = Number(row.msgs ?? 0);
  const scoreSum = Number(row.score_sum ?? 0);
  return {
    iss: String(row.iss),
    sub: String(row.sub),
    name: name || String(row.name ?? ""),
    msgs,
    scoreSum,
    avgScore: msgs > 0 ? scoreSum / msgs : 0,
    blocksMild: Number(row.blocks_mild ?? 0),
    blocksSevere: Number(row.blocks_severe ?? 0),
    strikes: Number(row.strikes ?? 0),
    strikesAt: Number(row.strikes_at ?? 0),
    prevMuteTier: Number(row.prev_mute_tier ?? 0),
    mutes: Number(row.mutes ?? 0),
    mutedUntil: Number(row.muted_until ?? 0),
    lastSeen: Number(row.last_seen ?? 0),
  };
}

/**
 * Record a strike: increments counters, decays prior strikes, writes new
 * strikes value, applies mute if a new tier was crossed. Returns the fresh
 * standing after the write.
 */
export async function recordStrike(
  db: D1Database,
  prior: Standing,
  result: ModerationResult,
  matchId: string,
  cfg: DisciplineConfig,
): Promise<Standing> {
  await ensureSchema(db);
  const now = Date.now();
  const w = weightFor(result, cfg);
  const score = scoreFor(result);
  const addSevere = result.severity === "severe" ? 1 : 0;
  const addMild = result.severity === "mild" ? 1 : 0;
  const addSum = score ?? 0;
  const addMsgs = score !== null ? 1 : 0;

  const decayed = effectiveStrikes(prior.strikes, prior.strikesAt, now, cfg);
  const newStrikes = decayed + w;
  const tier = penaltyFor(newStrikes, prior.prevMuteTier, cfg);
  const newMutedUntil = tier ? now + tier.muteMs : prior.mutedUntil;
  const newPrevTier = tier ? tier.points : prior.prevMuteTier;
  const newMutes = tier ? prior.mutes + 1 : prior.mutes;

  await db.batch([
    db.prepare(
      `INSERT INTO reputation (iss, sub, name, msgs, score_sum, blocks_mild, blocks_severe,
                               strikes, strikes_at, prev_mute_tier, mutes, muted_until, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(iss, sub) DO UPDATE SET
         name = excluded.name,
         msgs = msgs + ?4,
         score_sum = score_sum + ?5,
         blocks_mild = blocks_mild + ?6,
         blocks_severe = blocks_severe + ?7,
         strikes = ?8,
         strikes_at = ?9,
         prev_mute_tier = ?10,
         mutes = ?11,
         muted_until = ?12,
         last_seen = ?13`,
    ).bind(
      prior.iss, prior.sub, prior.name,
      addMsgs, addSum, addMild, addSevere,
      newStrikes, now, newPrevTier, newMutes, newMutedUntil, now,
    ),
    db.prepare(
      `INSERT INTO violations (iss, sub, at, match_id, layer, severity, score, matched, weight)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      prior.iss, prior.sub, now, matchId,
      result.layer,
      result.severity ?? null,
      score,
      result.matched ? result.matched.join(",") : null,
      w,
    ),
  ]);

  return {
    ...prior,
    msgs: prior.msgs + addMsgs,
    scoreSum: prior.scoreSum + addSum,
    avgScore: (prior.msgs + addMsgs) > 0
      ? (prior.scoreSum + addSum) / (prior.msgs + addMsgs)
      : 0,
    blocksMild: prior.blocksMild + addMild,
    blocksSevere: prior.blocksSevere + addSevere,
    strikes: newStrikes,
    strikesAt: now,
    prevMuteTier: newPrevTier,
    mutes: newMutes,
    mutedUntil: newMutedUntil,
    lastSeen: now,
  };
}

/**
 * Flush accumulated clean-message counters (score sum + msg count) for a user.
 * Called periodically and on close. Does NOT touch strikes/mute fields.
 */
export async function flushSession(
  db: D1Database,
  iss: string,
  sub: string,
  name: string,
  addMsgs: number,
  addScoreSum: number,
): Promise<void> {
  if (addMsgs <= 0) return;
  await ensureSchema(db);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO reputation (iss, sub, name, msgs, score_sum, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(iss, sub) DO UPDATE SET
       name = excluded.name,
       msgs = msgs + ?4,
       score_sum = score_sum + ?5,
       last_seen = ?6`,
  ).bind(iss, sub, name, addMsgs, addScoreSum, now).run();
}

/** Admin: pardon. Zeroes strikes, mute, and prev tier. Keeps lifetime counters. */
export async function pardonUser(db: D1Database, iss: string, sub: string): Promise<void> {
  await ensureSchema(db);
  await db.prepare(
    `UPDATE reputation
       SET strikes = 0, strikes_at = ?3, prev_mute_tier = 0, muted_until = 0
     WHERE iss = ?1 AND sub = ?2`,
  ).bind(iss, sub, Date.now()).run();
}

/** Admin: manual mute for a duration (ms). Row created if missing. */
export async function manualMute(
  db: D1Database,
  iss: string,
  sub: string,
  name: string,
  durationMs: number,
): Promise<void> {
  await ensureSchema(db);
  const now = Date.now();
  const until = now + Math.max(0, durationMs);
  await db.prepare(
    `INSERT INTO reputation (iss, sub, name, mutes, muted_until, last_seen)
     VALUES (?1, ?2, ?3, 1, ?4, ?5)
     ON CONFLICT(iss, sub) DO UPDATE SET
       name = excluded.name,
       mutes = mutes + 1,
       muted_until = ?4,
       last_seen = ?5`,
  ).bind(iss, sub, name, until, now).run();
}

export interface OffenderRow extends Standing {
  rank: number;
}

/** Admin: top offenders ordered by one of avg|strikes|blocks. */
export async function listOffenders(
  db: D1Database,
  order: "avg" | "strikes" | "blocks",
  minMsgs: number,
  limit: number,
): Promise<OffenderRow[]> {
  await ensureSchema(db);
  const orderExpr =
    order === "strikes" ? "strikes DESC" :
    order === "blocks"  ? "(blocks_severe * 10 + blocks_mild) DESC" :
    "(CASE WHEN msgs > 0 THEN score_sum / msgs ELSE 0 END) DESC";
  const rs = await db.prepare(
    `SELECT iss, sub, name, msgs, score_sum, blocks_mild, blocks_severe,
            strikes, strikes_at, prev_mute_tier, mutes, muted_until, last_seen
     FROM reputation
     WHERE msgs >= ?1
     ORDER BY ${orderExpr}
     LIMIT ?2`,
  ).bind(minMsgs, limit).all<Record<string, unknown>>();
  const out: OffenderRow[] = [];
  (rs.results ?? []).forEach((row, i) => {
    const msgs = Number(row.msgs ?? 0);
    const scoreSum = Number(row.score_sum ?? 0);
    out.push({
      iss: String(row.iss),
      sub: String(row.sub),
      name: String(row.name ?? ""),
      msgs, scoreSum,
      avgScore: msgs > 0 ? scoreSum / msgs : 0,
      blocksMild: Number(row.blocks_mild ?? 0),
      blocksSevere: Number(row.blocks_severe ?? 0),
      strikes: Number(row.strikes ?? 0),
      strikesAt: Number(row.strikes_at ?? 0),
      prevMuteTier: Number(row.prev_mute_tier ?? 0),
      mutes: Number(row.mutes ?? 0),
      mutedUntil: Number(row.muted_until ?? 0),
      lastSeen: Number(row.last_seen ?? 0),
      rank: i + 1,
    });
  });
  return out;
}

export interface ViolationRow {
  id: number;
  at: number;
  matchId: string;
  layer: string;
  severity: string | null;
  score: number | null;
  matched: string | null;
  weight: number;
}

export async function listViolations(
  db: D1Database,
  iss: string,
  sub: string,
  limit: number,
): Promise<ViolationRow[]> {
  await ensureSchema(db);
  const rs = await db.prepare(
    `SELECT id, at, match_id, layer, severity, score, matched, weight
     FROM violations
     WHERE iss = ?1 AND sub = ?2
     ORDER BY at DESC
     LIMIT ?3`,
  ).bind(iss, sub, limit).all<Record<string, unknown>>();
  return (rs.results ?? []).map((row) => ({
    id: Number(row.id),
    at: Number(row.at),
    matchId: String(row.match_id ?? ""),
    layer: String(row.layer ?? ""),
    severity: row.severity ? String(row.severity) : null,
    score: row.score !== null && row.score !== undefined ? Number(row.score) : null,
    matched: row.matched ? String(row.matched) : null,
    weight: Number(row.weight ?? 0),
  }));
}
