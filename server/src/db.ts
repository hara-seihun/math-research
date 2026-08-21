import postgres from "postgres";

// One connection per instance is not enough and a hundred is worse than
// useless: every connection is a Postgres backend process with its own
// work_mem allowance. Sized against the instance count in configuration.nix.
const POOL = Number(process.env.PG_POOL ?? 12);

const common = { max: POOL, onnotice: () => {} } as const;

export const sql = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL, common)
  : postgres({
      host: process.env.PGHOST ?? "/run/postgresql",
      database: process.env.PGDATABASE ?? "math",
      ...(process.env.PGUSER ? { username: process.env.PGUSER } : {}),
      ...common,
    });

// --- Request log ------
// Every tool call records what was asked. That is a fact worth keeping, but it
// used to be a synchronous INSERT on the critical path of every call: one
// serialized round trip before any of the work started. It is telemetry, so it
// rides behind the answer instead of in front of it, batched into one
// multi-row insert per flush window.

type LogRow = { tool: string; identityId: string | null; args: string };

const LOG_FLUSH_MS = Number(process.env.LOG_FLUSH_MS ?? 200);
const LOG_FLUSH_ROWS = 512;

let pending: LogRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushLog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  try {
    await sql`
      insert into request_log (tool, identity_id, args)
      select * from unnest(${batch.map((r) => r.tool)}::text[],
                           ${batch.map((r) => r.identityId)}::text[],
                           ${batch.map((r) => r.args)}::jsonb[])`;
  } catch (error) {
    // Losing telemetry must never take a request with it, but it must not be
    // silent either: a request log that has quietly stopped writing looks
    // exactly like an endpoint nobody is calling.
    console.error("request_log flush failed", error);
  }
}

export function logRequest(tool: string, identityId: string | null, args: unknown): void {
  const text = JSON.stringify(args ?? {});
  const stored =
    text.length > 8192
      ? JSON.stringify({ truncated: true, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") })
      : text;
  pending.push({ tool, identityId, args: stored });
  if (pending.length >= LOG_FLUSH_ROWS) {
    void flushLog();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushLog(), LOG_FLUSH_MS);
    flushTimer.unref();
  }
}

/** Drain the buffer, for shutdown and for tests that assert on the log. */
export const drainRequestLog = flushLog;

/** The log is a scanning surface, not an archive; a year of it helps nobody. */
export const pruneRequestLog = () =>
  sql`delete from request_log where created_at < now() - interval '30 days'`;
