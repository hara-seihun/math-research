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

/** The relations that close a question. Every read path that asks "what
 *  settles this?" asks it with the same list, and refresh_state derives the
 *  `settled` state from it in schema.sql. */
export const SETTLES = ["answers", "proves", "disproves", "refutes", "resolves"];

/** Certified mathematics: what this ledger established first and review has
 *  vouched for.
 *
 *  Certification is a certificate on the row, not a property of the row's
 *  kind: this ledger records a finding as a question its own closure settles
 *  at least as often as it records one as a `theorem`, so a board picked by
 *  kind ranks campaign scaffolding and misses the results. Either a T2
 *  settling link of ledger origin, or an applied impact assessment with
 *  nothing established elsewhere closing the same question.
 *
 *  A fragment over a `contribution` aliased `c`, built fresh per call because
 *  a fragment is consumed by the query it is interpolated into. */
export const certified = () => sql`
  c.origin = 'ledger' and (
    exists (select 1 from edge be
            join contribution bec on bec.id = be.contribution_id
            join contribution bsetter on bsetter.id = be.src
            where be.dst = c.id and be.rel = any(${SETTLES})
              and bec.status = 'active' and bsetter.status = 'active'
              and bec.tier >= 2 and bsetter.origin = 'ledger')
    or (c.impact_assessments > 0 and not exists (
          select 1 from edge xe
          join contribution xec on xec.id = xe.contribution_id
          join contribution xsetter on xsetter.id = xe.src
          where xe.dst = c.id and xe.rel = any(${SETTLES})
            and xec.status = 'active' and xsetter.status = 'active'
            and xsetter.origin = 'external')))`;

/** A row on the board has to say what was found. A closure keeps its question
 *  as an entry and as a name, but its headline is the answer: "Λ ≤ 0.1629 is
 *  independently certified", not "can Λ ≤ 0.1629 be independently certified?".
 *  An interrogative headline reads as an unanswered question wherever it is
 *  ranked, and the top of an all-time board of established mathematics is the
 *  worst possible place to read that way. */
export const statesAFinding = () => sql`right(btrim(c.title), 1) <> '?'`;

/** The all-time board: certified mathematics, headlined by what was found,
 *  which is what lemma.ing/results publishes and what `order_by: 'impact'` is
 *  worth ordering. A certified row that still asks its question is held off
 *  and handed to review as `asking_closures` instead of shipped as a
 *  headline. */
export const onBoard = () => sql`(${certified()}) and ${statesAFinding()}`;

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
