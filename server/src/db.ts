import postgres from "postgres";
import { requestContext } from "./request-context.ts";

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

/** The relations that close a question. Every read path that asks "what
 *  settles this?" asks it with the same list, and refresh_state derives the
 *  `settled` state from it in schema.sql. */
export const SETTLES = ["answers", "proves", "disproves", "refutes", "resolves"];

/** Certified mathematics: what this ledger established first and review has
 *  vouched for. The rule itself is `is_certified` in schema.sql, where the
 *  refresh that materializes board membership also reads it; this is that one
 *  rule asked about a `contribution` aliased `c`. */
export const certified = () => sql`is_certified(c.id)`;

/** A row on the board has to say what was found: "Λ ≤ 0.1629 is independently
 *  certified", not "can Λ ≤ 0.1629 be independently certified?". */
export const statesAFinding = () => sql`title_states_finding(c.title)`;

/** The all-time board: certified mathematics, headlined by what was found,
 *  which is what lemma.ing/results publishes and what `order_by: 'impact'` is
 *  worth ordering. Membership is materialized as the moment it began, so this
 *  is a column test rather than a walk of the graph, and `board_at` is also
 *  what a time window on the board means. A certified row that still asks its
 *  question is off it and handed to review as `asking_closures` instead of
 *  shipped as a headline. */
export const onBoard = () => sql`c.board_at is not null`;

/** Which clock a `since` window runs on. Off the board it is submission time;
 *  on the board it is arrival time, because review certifies a week-old
 *  closure and the day it did so is the news. */
export const windowColumn = (board: boolean | undefined) => (board ? sql`c.board_at` : sql`c.created_at`);

/** Exclude mathematics established elsewhere. This removes directly external
 *  entries and questions with an active external closure, while retaining
 *  ordinary ledger results that do not settle a question. */
export const withoutExternalResults = () => sql`
  c.origin = 'ledger' and not exists (
    select 1 from edge xe
    join contribution xec on xec.id = xe.contribution_id
    join contribution xsetter on xsetter.id = xe.src
    where xe.dst = c.id and xe.rel = any(${SETTLES})
      and xec.status = 'active' and xsetter.status = 'active'
      and xsetter.origin = 'external')`;

/** What ranks the board: the reviewed 0-5 dimensions, twice, over heavily
 *  damped graph importance. Also a fragment over a `contribution` aliased `c`. */
export const impactScore = () => sql`
  round((2 * (coalesce(c.impact_reach, 0) + coalesce(c.impact_advance, 0) + coalesce(c.impact_closure, 0))
         + 2 * ln(1 + greatest(c.notability, 0)))::numeric, 3)::real`;

// --- Request log ------
// Every tool call records what was asked. That is a fact worth keeping, but it
// used to be a synchronous INSERT on the critical path of every call: one
// serialized round trip before any of the work started. It is telemetry, so it
// rides behind the answer instead of in front of it, batched into one
// multi-row insert per flush window.

type LogRow = { tool: string; identityId: string | null; session: string | null; args: string };

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
    // The cast is per element, not on the array. Handed an array of JSON
    // strings for a jsonb[] parameter, the driver encodes each one as a JSON
    // string literal, so every row landed holding a quoted blob instead of an
    // object and `args->>'query'` matched nothing. Unnest as text, cast each.
    await sql`
      insert into request_log (tool, identity_id, session, args)
      select tool, identity_id, session, args::jsonb
      from unnest(${batch.map((r) => r.tool)}::text[],
                  ${batch.map((r) => r.identityId)}::text[],
                  ${batch.map((r) => r.session)}::text[],
                  ${batch.map((r) => r.args)}::text[])
        as row (tool, identity_id, session, args)`;
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
  // The connection, not just the contributor: read doors log no identity at
  // all (they resolve none), so a session is the only thread that ties a
  // caller's calls together -- which is what feedback attaches so a
  // one-sentence complaint still says what its author was doing.
  pending.push({ tool, identityId, session: requestContext().sessionId ?? null, args: stored });
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
