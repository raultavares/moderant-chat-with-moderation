/**
 * CLI entrypoint for the loadtest.
 *
 * Usage:
 *   pnpm run run -- --profile=lobby --users=150 --duration=120
 *   pnpm run run -- --profile=hot --users=150 --duration=120
 *   pnpm run run -- --profile=storm --users=150 --duration=60
 *   pnpm run run -- --profile=squad --users=150 --duration=180   # 30 teams of 5
 *   pnpm run run -- --profile=match --users=150 --duration=180   # 15 matches of 10
 *   pnpm run run -- --profile=party --users=150 --duration=180   # 3 rooms of 50
 *
 * Flags:
 *   --profile=lobby|hot|storm|mega|squad|match|party  preset shape.
 *   --users=N                  total simulated bots.
 *   --matches=N                override number of matches to spread across
 *                              (only applies to lobby; hot/storm use 1).
 *   --duration=SECONDS         total run duration.
 *   --rate=min:max             override send interval (ms range),
 *                              e.g. --rate=500:2000 means 0.5-2s between msgs.
 *   --match-ids=id1,id2,...    pin to specific matchIds instead of random ones.
 *                              defaults to loadtest-match-N opaque placeholders.
 *   --unique                   append a short random tag to each message so
 *                              every request misses the AI Gateway cache.
 *                              use this to measure true uncached model latency.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Bot, type BotMetrics } from "./bot.js";
import { mintBotTokens } from "./mint.js";
import { aggregate, printSummary, writeCsv } from "./report.js";

interface ProfileConfig {
  matches: number;
  sendIntervalMinMs: number;
  sendIntervalMaxMs: number;
  defaultDurationSec: number;
}

const PROFILES: Record<string, ProfileConfig> = {
  lobby: {
    matches: 10,
    sendIntervalMinMs: 20_000,
    sendIntervalMaxMs: 60_000,
    defaultDurationSec: 120,
  },
  hot: {
    matches: 1,
    sendIntervalMinMs: 10_000,
    sendIntervalMaxMs: 30_000,
    defaultDurationSec: 120,
  },
  storm: {
    matches: 1,
    sendIntervalMinMs: 1_000,
    sendIntervalMaxMs: 2_000,
    defaultDurationSec: 60,
  },
  mega: {
    // 300 users in one room with realistic per-user chat rate.
    // Aggregate ~8-15 msg/s into one DO. Stresses broadcast fan-out
    // (each say echoes to 299 sockets) and Clef throughput.
    // RL_PER_IP must be raised server-side first, else per-IP cap bites.
    matches: 1,
    sendIntervalMinMs: 20_000,
    sendIntervalMaxMs: 40_000,
    defaultDurationSec: 180,
  },
  // ---- realistic game-shape profiles ----
  // These mirror actual commercial game chat topologies.
  squad: {
    // Valorant / CS2 / Overwatch style: 5-player team chat.
    // 30 concurrent squads = 150 users across 30 rooms.
    // Rate: 3 msgs/min/player during active play.
    matches: 30,
    sendIntervalMinMs: 15_000,
    sendIntervalMaxMs: 25_000,
    defaultDurationSec: 180,
  },
  match: {
    // Dota 2 / LoL / Overwatch match-wide chat: 10 players per match.
    // 15 concurrent matches = 150 users across 15 rooms.
    // Rate: 2-3 msgs/min/player, bursty around round ends.
    matches: 15,
    sendIntervalMinMs: 20_000,
    sendIntervalMaxMs: 30_000,
    defaultDurationSec: 180,
  },
  party: {
    // Social hub / VRChat lobby / Fortnite party: ~50 per room.
    // 3 concurrent parties = 150 users across 3 rooms.
    // Rate: lower, chat is secondary (2 msgs/min/player).
    matches: 3,
    sendIntervalMinMs: 25_000,
    sendIntervalMaxMs: 40_000,
    defaultDurationSec: 180,
  },
};

interface Args {
  profile: string;
  users: number;
  matches: number;
  durationSec: number;
  sendIntervalMinMs: number;
  sendIntervalMaxMs: number;
  matchIds: string[];
  unique: boolean;
  toxicCount: number;
  subPrefix: string;
}

function parseArgs(): Args {
  const argMap = new Map<string, string>();
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [k, v] = raw.slice(2).split("=");
    if (k) argMap.set(k, v ?? "true");
  }

  const profile = argMap.get("profile") ?? "lobby";
  const pcfg = PROFILES[profile];
  if (!pcfg) {
    throw new Error(
      `unknown profile: ${profile} (choose: ${Object.keys(PROFILES).join(", ")})`,
    );
  }
  const users = parseInt(argMap.get("users") ?? "150", 10);
  const matches = parseInt(argMap.get("matches") ?? String(pcfg.matches), 10);
  const durationSec = parseInt(argMap.get("duration") ?? String(pcfg.defaultDurationSec), 10);

  let sendIntervalMinMs = pcfg.sendIntervalMinMs;
  let sendIntervalMaxMs = pcfg.sendIntervalMaxMs;
  if (argMap.has("rate")) {
    const parts = argMap.get("rate")!.split(":");
    if (parts.length === 2) {
      sendIntervalMinMs = parseInt(parts[0]!, 10);
      sendIntervalMaxMs = parseInt(parts[1]!, 10);
    }
  }

  const matchIds = (argMap.get("match-ids") ?? defaultMatchIds(matches))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const unique = argMap.has("unique");
  const toxicCount = Math.max(0, parseInt(argMap.get("toxic") ?? "0", 10));
  // Unique prefix so strikes/discipline do not carry over between runs.
  const subPrefix =
    argMap.get("sub-prefix") ??
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

  return {
    profile,
    users,
    matches: matchIds.length,
    durationSec,
    sendIntervalMinMs,
    sendIntervalMaxMs,
    matchIds,
    unique,
    toxicCount,
    subPrefix,
  };
}

/**
 * Build N synthetic match IDs. The chat Worker doesn't validate matchId
 * against KV MATCHES; it only requires jwt.matchId == URL matchId. So any
 * string works for load testing. We use loadtest-match-NNN so you can
 * easily see loadtest traffic separately in logs / DO IDs.
 */
function defaultMatchIds(n: number): string {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(`loadtest-match-${String(i).padStart(3, "0")}`);
  }
  return ids.join(",");
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("=== moderant loadtest ===");
  console.log("profile:        ", args.profile);
  console.log("users:          ", args.users);
  console.log("matches:        ", args.matches);
  console.log("duration:       ", args.durationSec, "s");
  console.log("send interval:  ", args.sendIntervalMinMs, "-", args.sendIntervalMaxMs, "ms");
  console.log("match ids:      ", args.matchIds.slice(0, 5).join(", "), args.matchIds.length > 5 ? `...+${args.matchIds.length - 5}` : "");
  console.log("unique mode:    ", args.unique ? "yes (cache-busting on)" : "no");
  console.log("toxic bots:     ", args.toxicCount > 0 ? `${args.toxicCount} (slurs/threats only, triggers discipline)` : "none");
  console.log("sub prefix:     ", args.subPrefix, "(unique per run)");
  console.log("");

  console.log("[mint] signing", args.users, "bot tokens...");
  const mintStart = Date.now();
  const tokens = await mintBotTokens({
    count: args.users,
    matchIds: args.matchIds,
    subPrefix: args.subPrefix,
  });
  console.log("[mint] done in", Date.now() - mintStart, "ms");

  console.log("[connect] opening", args.users, "WebSockets...");
  const startedAt = new Date();
  const bots = tokens.map(
    (tok, i) =>
      new Bot({
        token: tok,
        sendIntervalMinMs: args.sendIntervalMinMs,
        sendIntervalMaxMs: args.sendIntervalMaxMs,
        durationMs: args.durationSec * 1000,
        pendingTimeoutMs: 30_000,
        unique: args.unique,
        toxic: i < args.toxicCount,
      }),
  );

  // Stagger connects slightly to avoid 150 TLS handshakes in one millisecond.
  const connectJitterMs = 10;
  const runPromises: Promise<BotMetrics>[] = [];
  for (let i = 0; i < bots.length; i++) {
    runPromises.push(
      new Promise((resolve) => {
        setTimeout(() => resolve(bots[i]!.run()), i * connectJitterMs);
      }),
    );
  }

  // Graceful stop on Ctrl+C.
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[stop] SIGINT received, closing bots...");
    for (const b of bots) b.stop("sigint");
  });

  // Progress ticker.
  const tickerStart = Date.now();
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - tickerStart) / 1000);
    const sent = bots.reduce((a, b) => a + b.metrics.messages.length, 0);
    const resolved = bots.reduce(
      (a, b) => a + b.metrics.messages.filter((m) => m.outcome).length,
      0,
    );
    process.stdout.write(
      `\r[progress] ${elapsed}s elapsed  sent=${sent}  resolved=${resolved}       `,
    );
  }, 2000);

  const allMetrics = await Promise.all(runPromises);
  clearInterval(ticker);
  process.stdout.write("\n");
  const endedAt = new Date();

  const summary = aggregate(allMetrics, {
    profile: args.profile,
    users: args.users,
    matches: args.matches,
    durationSec: args.durationSec,
    startedAt,
    endedAt,
  });

  printSummary(summary);

  const runsDir = resolve(new URL(".", import.meta.url).pathname, "../runs");
  mkdirSync(runsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const csvPath = resolve(runsDir, `${stamp}-${args.profile}-${args.users}u.csv`);
  const jsonPath = resolve(runsDir, `${stamp}-${args.profile}-${args.users}u.json`);
  writeCsv(csvPath, allMetrics);
  await import("node:fs").then((fs) =>
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2) + "\n"),
  );
  console.log(`\n[write] ${csvPath}`);
  console.log(`[write] ${jsonPath}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
