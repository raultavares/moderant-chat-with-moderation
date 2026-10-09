/**
 * Aggregate per-bot metrics into a summary and emit CSV + console tables.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BotMetrics, MessageOutcome, SentMessage } from "./bot.js";
import type { CorpusEntry } from "./corpus.js";

export interface RunSummary {
  profile: string;
  users: number;
  matches: number;
  durationSec: number;
  startedAt: string;
  endedAt: string;
  wallClockSec: number;

  botsConnected: number;
  botsFailedToConnect: number;

  messagesSent: number;
  messagesResolved: number;
  outcomes: Record<MessageOutcome, number>;

  // M4.14: discipline-related counters.
  standingFramesTotal: number;
  botsMuted: number;

  latency: {
    count: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
  };

  // Connect latency: ms from TCP open to welcome frame. Includes the D1 read.
  connectLatency: {
    count: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
  };

  byCategory: Partial<Record<CorpusEntry["category"], CategoryBreakdown>>;
  byLayer: Record<string, number>;      // blocked moderation layer counts
  byRateScope: Record<string, number>;  // rate_limit scope counts
  errorCodes: Record<string, number>;
  connectErrorReasons: Record<string, number>;
}

export interface CategoryBreakdown {
  sent: number;
  confirmed: number;
  blocked: number;
  rate_limited: number;
  muted: number;
  errored: number;
  timed_out: number;
  avgLatencyMs: number | null;
}

export function aggregate(
  all: BotMetrics[],
  meta: {
    profile: string;
    users: number;
    matches: number;
    durationSec: number;
    startedAt: Date;
    endedAt: Date;
  },
): RunSummary {
  const allMessages: SentMessage[] = [];
  const outcomes: Record<MessageOutcome, number> = {
    confirmed: 0,
    blocked: 0,
    rate_limited: 0,
    muted: 0,
    errored: 0,
    timed_out: 0,
  };
  const byCategory: Partial<Record<CorpusEntry["category"], CategoryBreakdown>> = {};
  const byLayer: Record<string, number> = {};
  const byRateScope: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const connectErrorReasons: Record<string, number> = {};

  let botsConnected = 0;
  let botsFailedToConnect = 0;
  let standingFramesTotal = 0;
  let botsMuted = 0;
  const connectLatencies: number[] = [];

  for (const b of all) {
    if (b.connected) botsConnected++;
    else {
      botsFailedToConnect++;
      const key = b.connectErrorReason ?? `code_${b.connectErrorCode ?? "?"}`;
      connectErrorReasons[key] = (connectErrorReasons[key] ?? 0) + 1;
    }
    standingFramesTotal += b.standingFrames;
    if (b.mutedAt) botsMuted++;
    if (typeof b.connectLatencyMs === "number") connectLatencies.push(b.connectLatencyMs);
    for (const m of b.messages) allMessages.push(m);
  }
  connectLatencies.sort((a, b) => a - b);

  for (const m of allMessages) {
    const cb = ensureCategory(byCategory, m.category);
    cb.sent++;
    if (m.outcome) {
      outcomes[m.outcome]++;
      cb[m.outcome]++;
    }
    if (m.outcome === "blocked" && m.moderationLayer) {
      byLayer[m.moderationLayer] = (byLayer[m.moderationLayer] ?? 0) + 1;
    }
    if (m.outcome === "rate_limited" && m.rateLimitScope) {
      byRateScope[m.rateLimitScope] = (byRateScope[m.rateLimitScope] ?? 0) + 1;
    }
    if (m.outcome === "errored" && m.errorCode) {
      errorCodes[m.errorCode] = (errorCodes[m.errorCode] ?? 0) + 1;
    }
  }

  for (const [cat, cb] of Object.entries(byCategory)) {
    const resolved = allMessages.filter(
      (m) => m.category === cat && m.latencyMs !== undefined,
    );
    cb!.avgLatencyMs = resolved.length
      ? resolved.reduce((a, m) => a + (m.latencyMs ?? 0), 0) / resolved.length
      : null;
  }

  const latencies = allMessages
    .filter((m) => m.latencyMs !== undefined && m.outcome !== "timed_out")
    .map((m) => m.latencyMs!) as number[];
  latencies.sort((a, b) => a - b);

  const latency = {
    count: latencies.length,
    minMs: latencies[0] ?? 0,
    maxMs: latencies[latencies.length - 1] ?? 0,
    avgMs:
      latencies.length === 0
        ? 0
        : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50Ms: pct(latencies, 50),
    p90Ms: pct(latencies, 90),
    p95Ms: pct(latencies, 95),
    p99Ms: pct(latencies, 99),
  };

  return {
    profile: meta.profile,
    users: meta.users,
    matches: meta.matches,
    durationSec: meta.durationSec,
    startedAt: meta.startedAt.toISOString(),
    endedAt: meta.endedAt.toISOString(),
    wallClockSec:
      Math.round((meta.endedAt.getTime() - meta.startedAt.getTime()) / 100) / 10,
    botsConnected,
    botsFailedToConnect,
    messagesSent: allMessages.length,
    messagesResolved: allMessages.filter((m) => m.outcome).length,
    outcomes,
    standingFramesTotal,
    botsMuted,
    latency,
    connectLatency: {
      count: connectLatencies.length,
      avgMs: connectLatencies.length
        ? Math.round(connectLatencies.reduce((a, b) => a + b, 0) / connectLatencies.length)
        : 0,
      p50Ms: pct(connectLatencies, 50),
      p95Ms: pct(connectLatencies, 95),
      maxMs: connectLatencies[connectLatencies.length - 1] ?? 0,
    },
    byCategory,
    byLayer,
    byRateScope,
    errorCodes,
    connectErrorReasons,
  };
}

function ensureCategory(
  map: Partial<Record<CorpusEntry["category"], CategoryBreakdown>>,
  cat: CorpusEntry["category"],
): CategoryBreakdown {
  let cb = map[cat];
  if (!cb) {
    cb = {
      sent: 0,
      confirmed: 0,
      blocked: 0,
      rate_limited: 0,
      muted: 0,
      errored: 0,
      timed_out: 0,
      avgLatencyMs: null,
    };
    map[cat] = cb;
  }
  return cb;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

export function writeCsv(path: string, bots: BotMetrics[]): void {
  const rows: string[] = [
    "bot_sub,match_id,cid,category,text,sent_at,resolved_at,outcome,latency_ms,moderation_layer,moderation_severity,rate_scope,error_code",
  ];
  for (const b of bots) {
    for (const m of b.messages) {
      rows.push(
        [
          b.sub,
          b.matchId,
          m.cid,
          m.category,
          csvEscape(m.text),
          m.sentAt,
          m.resolvedAt ?? "",
          m.outcome ?? "",
          m.latencyMs ?? "",
          m.moderationLayer ?? "",
          m.moderationSeverity ?? "",
          m.rateLimitScope ?? "",
          m.errorCode ?? "",
        ].join(","),
      );
    }
  }
  writeFileSync(resolve(path), rows.join("\n") + "\n", "utf8");
}

function csvEscape(s: string): string {
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function printSummary(s: RunSummary): void {
  const line = (c = 80) => console.log("-".repeat(c));
  line();
  console.log(`moderant loadtest - ${s.profile}`);
  line();
  console.log(`users:              ${s.users} across ${s.matches} match(es)`);
  console.log(`duration:           ${s.durationSec}s target, ${s.wallClockSec}s actual`);
  console.log(`started:            ${s.startedAt}`);
  console.log(`ended:              ${s.endedAt}`);
  line();
  console.log(`bots connected:     ${s.botsConnected}/${s.users} (${s.botsFailedToConnect} failed)`);
  console.log(`messages sent:      ${s.messagesSent}`);
  console.log(`messages resolved:  ${s.messagesResolved}`);
  console.log(`standing frames:    ${s.standingFramesTotal}`);
  console.log(`bots muted:         ${s.botsMuted}`);
  line();
  console.log("outcomes:");
  for (const [k, v] of Object.entries(s.outcomes)) {
    const pctStr =
      s.messagesSent > 0
        ? ` (${((v / s.messagesSent) * 100).toFixed(1)}%)`
        : "";
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}${pctStr}`);
  }
  line();
  console.log("latency (resolved, ms):");
  console.log(`  count:  ${s.latency.count}`);
  console.log(`  min:    ${s.latency.minMs}`);
  console.log(`  avg:    ${s.latency.avgMs}`);
  console.log(`  p50:    ${s.latency.p50Ms}`);
  console.log(`  p90:    ${s.latency.p90Ms}`);
  console.log(`  p95:    ${s.latency.p95Ms}`);
  console.log(`  p99:    ${s.latency.p99Ms}`);
  console.log(`  max:    ${s.latency.maxMs}`);
  line();
  console.log("connect latency (open -> welcome, ms):");
  console.log(`  count:  ${s.connectLatency.count}`);
  console.log(`  avg:    ${s.connectLatency.avgMs}`);
  console.log(`  p50:    ${s.connectLatency.p50Ms}`);
  console.log(`  p95:    ${s.connectLatency.p95Ms}`);
  console.log(`  max:    ${s.connectLatency.maxMs}`);
  line();
  console.log("by category:");
  for (const [cat, cb] of Object.entries(s.byCategory)) {
    if (!cb) continue;
    console.log(
      `  ${cat.padEnd(14)} sent=${String(cb.sent).padStart(5)} ` +
        `ok=${String(cb.confirmed).padStart(5)} ` +
        `blocked=${String(cb.blocked).padStart(5)} ` +
        `muted=${String(cb.muted).padStart(5)} ` +
        `rate=${String(cb.rate_limited).padStart(5)} ` +
        `err=${String(cb.errored).padStart(4)} ` +
        `timed=${String(cb.timed_out).padStart(4)} ` +
        `avg=${cb.avgLatencyMs !== null ? Math.round(cb.avgLatencyMs) + "ms" : "-"}`,
    );
  }
  line();
  if (Object.keys(s.byLayer).length > 0) {
    console.log("block layer breakdown:");
    for (const [k, v] of Object.entries(s.byLayer)) {
      console.log(`  ${k.padEnd(14)} ${v}`);
    }
    line();
  }
  if (Object.keys(s.byRateScope).length > 0) {
    console.log("rate-limit scope breakdown:");
    for (const [k, v] of Object.entries(s.byRateScope)) {
      console.log(`  ${k.padEnd(14)} ${v}`);
    }
    line();
  }
  if (Object.keys(s.errorCodes).length > 0) {
    console.log("error codes:");
    for (const [k, v] of Object.entries(s.errorCodes)) {
      console.log(`  ${k.padEnd(30)} ${v}`);
    }
    line();
  }
  if (Object.keys(s.connectErrorReasons).length > 0) {
    console.log("connect failure reasons:");
    for (const [k, v] of Object.entries(s.connectErrorReasons)) {
      console.log(`  ${k.padEnd(50)} ${v}`);
    }
    line();
  }
}
