// Runtime env bindings for worker-admin. Must match the bindings block in
// terraform/main.tf (resource "cloudflare_workers_script" "admin").

// Minimal structural type for the chat worker's RoomDO (admin RPC surface).
// Avoids a cross-script type import, which would drag in worker-chat's Env.
// Extends Rpc.DurableObjectBranded so stub.method() is exposed on the Fetcher<T>.
interface RoomDORpc extends Rpc.DurableObjectBranded {
  adminRoster(): Promise<Array<{
    sub: string;
    name: string;
    iss: string;
    joinedAt: number;
    standing: {
      strikes: number;
      watch: boolean;
      mutedUntil: number;
      msgs: number;
      scoreSum: number;
      avgScore: number;
      blocksMild: number;
      blocksSevere: number;
    };
  }>>;
  adminAction(args: {
    iss: string;
    sub: string;
    action: "pardon" | "mute";
    durationMs?: number;
  }): Promise<{ affectedSockets: number }>;
}

interface Env {
  DB: D1Database;
  // Cross-script DO binding: ROOM points at worker-chat's RoomDO.
  ROOM: DurableObjectNamespace<RoomDORpc>;
  // Bearer token for all /admin/* API calls.
  ADMIN_TOKEN: string;
  // JSON discipline config (same as chat worker).
  DISCIPLINE: string;
}
