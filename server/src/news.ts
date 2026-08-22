import { sql } from "./db.ts";
import { LIST_NOTE, listRow, trim } from "./read.ts";
import { corpus } from "./snapshot.ts";

// --- News ------
// "What has happened here since I last looked?" derived in the database rather
// than reassembled by every client. The cursor is the event ledger's own
// sequence number, so a window is exactly the events a reader has not seen,
// never a guessed time interval, never a double-read, never a gap.
//
// Everything here is an aggregate or a bounded top-N over that window, so the
// cost does not grow with how long someone stayed away: a reader returning
// after a hundred thousand events pays the same as one returning after ten.

/** A question is settled exactly when an active entry stands in one of these
 *  relations to it. Same list as refresh_state, which derives `state`. */
const SETTLE_RELS = ["answers", "proves", "disproves", "refutes", "resolves"];

/** Relations that carry partial progress toward a question. Same as frontier. */
const PROGRESS_RELS = ["serves", "partially-answers", "refines", "about", "uses", "generalizes"];

const SUB_RELS = ["reduces-to", "depends-on", "splits-into", "specializes", "serves"];

const TERMINAL_KINDS = ["retracted", "rejected", "restored", "superseded", "refactor-applied", "refactor-rejected", "flagged"];

const TRAIL_FRESH = "2 hours";

const DECLS_SHOWN = 12;

export const HOW_TO_READ = [
  "This is evidence for a summary, not the summary. Custody first. Every entry here, including every link, sits on one review ladder of T0 recorded (the author's claim, no review), T1 confirmed mathematics, T2 canon accepted by a trusted reviewer, and T3 published externally. lean_verified is an independent machine check and never a tier. It says the listed declarations compile, not that they mean what the prose around them claims.",
  "A question is settled when an active entry stands in an answers/proves/disproves/refutes/resolves relation to it. That is a fact about the graph: the settling entry and the settling link each still carry their own tier, and a fresh settlement is usually T0 until review reaches it. Say so, and treat a settlement as closing only the exact question the link points at, never a broader parent question or a whole programme.",
  "Settling is not the same as being first. A settling entry marked origin: 'external' records mathematics established outside this ledger, with origin_source naming what established it, so the question is genuinely closed here but the result is not ours. Never report such a closure as this ledger's own result. Name the source, and say the ledger recorded, replayed, or verified it.",
  "Retractions, rejections, supersessions and rejected refactors are terminal decisions, not advances; give the recorded reason. A rejection is review's other verdict: a trusted reviewer read the entry and threw it out, which also reopens anything it was claiming to settle, so treat it as evidence the queue is working rather than as a loss. Trails are diaries: an active trail is what someone is exploring, not a reservation and not a result.",
  "questions lists the open work worth forecasting: everything touched in this window, topped up by notability. Each carries where it stands, what partial progress exists and at which tier, where each distilled route stalls, who is exploring it now, and what was already tried, so a quiet window still supports a full forecast. If you are asked for the odds, give one whole-number subjective percentage per question that it will eventually be settled here, sorted high to low, alongside the recent advance, the concrete blocker, and the custody of the evidence. Those percentages are your judgment, not ledger fields; omit anything settled in this window and never write a 100% row.",
].join("\n\n");

/** The relation vocabulary is open: anyone can assert a link with a relation
 *  nobody has used before, and 176 of them have been. A movement summary wants
 *  what moved, so the tail past the top few is one number rather than 3 KB of
 *  singletons. Rows arrive already ordered by count. */
const KINDS_SHOWN = 20;

const rels = (rows: { rel: string | null; n: number }[]) => {
  const named = rows.filter((r) => r.rel);
  const head = Object.fromEntries(named.slice(0, KINDS_SHOWN).map((r) => [r.rel!, r.n]));
  const tail = named.slice(KINDS_SHOWN);
  if (!tail.length) return head;
  return { ...head, [`+${tail.length} rarer kinds`]: tail.reduce((n, r) => n + r.n, 0) };
};

/** Resolve a `since` into the last sequence number before it.
 *
 *  Ordered by created_at and stopped at the first row rather than aggregated:
 *  seq and created_at rise together, so the answer is one index seek. As a
 *  max() over a filter it was a backward walk of the whole ledger, and the
 *  cost of asking for "the last six hours" grew with the age of the corpus. */
export async function seqBefore(at: Date): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`
    select seq::int as seq from event where created_at < ${at} order by created_at desc, seq desc limit 1`;
  return row?.seq ?? 0;
}

export async function headSeq(): Promise<number> {
  const [row] = await sql<{ seq: number }[]>`select coalesce(max(seq), 0)::int as seq from event`;
  return row!.seq;
}


export async function newsPacket(from: number, head: number, questions: number, limit: number) {
  const window = sql`event.seq > ${from} and event.seq <= ${head}`;

  // Six full-corpus counts, and the same six hello opens with. Taken from the
  // shared snapshot rather than re-counted for every reader.
  const { totals } = await corpus.get();

  // Every count and top-N below reads the same event window and none of them
  // feeds another, so they go to the server together. Sequentially they were
  // fourteen round trips deep, which is most of what `news` used to cost.
  const [
    [span],
    eventKinds,
    newEntries,
    newLinks,
    settlements,
    [promotionCounts],
    promoted,
    [verificationCounts],
    verified,
    terminal,
    [terminalTotal],
    identities,
    activity,
  ] = await Promise.all([
    sql<{ events: number; from_at: Date | null; to_at: Date | null }[]>`
    select count(*)::int as events, min(created_at) as from_at, max(created_at) as to_at
    from event where ${window}`,
    sql<{ kind: string; n: number }[]>`
    select kind, count(*)::int as n from event where ${window} group by kind order by n desc`,
    sql<{ rel: string | null; n: number }[]>`
    select event.payload->>'kind' as rel, count(*)::int as n from event
    join contribution c on c.id = event.contribution_id and c.status = 'active'
    where ${window} and event.kind = 'submitted' and event.payload->>'kind' is distinct from 'edge'
    group by 1 order by n desc`,
    sql<{ rel: string | null; n: number }[]>`
    select event.payload->>'rel' as rel, count(*)::int as n from event
    join contribution c on c.id = event.contribution_id and c.status = 'active'
    where ${window} and event.kind = 'submitted' and event.payload->>'kind' = 'edge'
    group by 1 order by n desc`,
    sql`
    select q.id as question_id, q.kind as question_kind, q.title as question_title,
           q.summary as question_summary, q.tier as question_tier, q.state as question_state,
           q.notability as question_notability, q.lean_verified as question_lean_verified,
           q.names as question_names, q.created_at as question_created_at,
           s.id, s.kind, s.title, s.summary, s.tier, s.state, s.notability, s.lean_verified,
           s.names, s.created_at, s.origin, s.origin_source,
           event.payload->>'rel' as rel, ec.tier as edge_tier, event.created_at as linked_at
    from event
    join contribution ec on ec.id = event.contribution_id and ec.status = 'active'
    join contribution_overview q on q.id = (event.payload->>'dst')::uuid
    join contribution_overview s on s.id = (event.payload->>'src')::uuid
    where ${window} and event.kind = 'submitted' and event.payload->>'kind' = 'edge'
      and event.payload->>'rel' = any (${SETTLE_RELS})
      and q.kind in ('problem', 'conjecture') and q.status = 'active' and s.status = 'active'
    order by event.seq desc limit ${limit * 4}`,
    sql<{ total: number; links: number }[]>`
    select count(*)::int as total,
           count(*) filter (where c.kind = 'edge')::int as links
    from event join contribution c on c.id = event.contribution_id
    where ${window} and event.kind = 'tier-changed' and (event.payload->>'tier')::int >= 2`,
    sql`
    select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.origin, c.origin_source,
           c.names, c.created_at,
           (event.payload->>'tier')::int as promoted_to, event.payload->>'note' as note,
           event.created_at as at
    from event join contribution_overview c on c.id = event.contribution_id
    where ${window} and event.kind = 'tier-changed' and (event.payload->>'tier')::int >= 2
      and c.kind <> 'edge'
    order by event.seq desc limit ${limit}`,
    sql<{ passed: number; failed: number }[]>`
    select count(*) filter (where payload->>'outcome' = 'passed')::int as passed,
           count(*) filter (where payload->>'outcome' <> 'passed')::int as failed
    from event where ${window} and kind = 'verification'`,
    sql`
    select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.origin, c.origin_source,
           c.names, c.created_at, event.created_at as at,
           (select coalesce(array_agg(d->>'name') filter (where d->>'proof' is distinct from 'false'), '{}')
              from jsonb_array_elements(event.payload->'decls') d) as decls
    from event join contribution_overview c on c.id = event.contribution_id
    where ${window} and event.kind = 'verification' and event.payload->>'outcome' = 'passed'
    order by event.seq desc limit ${limit}`,
    sql`
    select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.origin, c.origin_source,
           c.names, c.created_at, c.status,
           event.kind as decision, event.payload->>'note' as note, event.created_at as at
    from event join contribution_overview c on c.id = event.contribution_id
    where ${window} and event.kind = any (${TERMINAL_KINDS})
    order by event.seq desc limit ${limit}`,
    sql<{ n: number }[]>`
    select count(*)::int as n from event where ${window} and kind = any (${TERMINAL_KINDS})`,
    sql<{ identity_id: string; display_name: string | null; n: number }[]>`
    select event.identity_id, i.display_name, count(*)::int as n
    from event left join identity i on i.id = event.identity_id
    where ${window} and event.identity_id is not null
    group by 1, 2 order by n desc limit 8`,
    // What the window argued about, which is what decides the questions this
    // packet forecasts.
    sql<{ id: string; rel: string; n: number }[]>`
    select (event.payload->>'dst')::uuid as id, event.payload->>'rel' as rel, count(*)::int as n
    from event join contribution ec on ec.id = event.contribution_id and ec.status = 'active'
    where ${window} and event.kind = 'submitted' and event.payload->>'kind' = 'edge'
    group by 1, 2`,
  ]);

  // --- Settlements. The link must still be active: a settlement asserted and
  // then retracted inside one window is not news that a question closed.
  const settled: Record<string, { question: unknown; by: unknown[] }> = {};
  for (const row of settlements) {
    const key = row.question_id as string;
    settled[key] ??= {
      question: listRow({
        id: row.question_id, kind: row.question_kind, title: row.question_title,
        summary: row.question_summary, tier: row.question_tier, state: row.question_state,
        notability: row.question_notability, lean_verified: row.question_lean_verified,
        names: row.question_names, created_at: row.question_created_at,
      }),
      by: [],
    };
    settled[key]!.by.push({ rel: row.rel, edge_tier: row.edge_tier, linked_at: row.linked_at, entry: listRow(row) });
  }

  const touched = new Map<string, Record<string, number>>();
  for (const row of activity) {
    const seen = touched.get(row.id) ?? {};
    seen[row.rel] = row.n;
    touched.set(row.id, seen);
  }

  // The same count hello reports, already derived on the shared snapshot.
  const openCount = { n: totals.open_questions };

  const chosen = await sql`
    select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.origin, c.origin_source,
           c.names, c.tags, c.created_at
    from contribution_overview c
    where c.status = 'active' and c.kind in ('problem', 'conjecture') and c.state = 'open'
    order by (c.id = any (${[...touched.keys()]}::uuid[])) desc, c.notability desc
    limit ${questions}`;
  const ids = chosen.map((row) => row.id as string);

  const [progress, subproblems, routes, fronts, exploring, tried] = ids.length
    ? await Promise.all([
        sql`select * from (
              select e.dst as q, m.id, m.kind, m.title, m.summary, m.tier, m.state, m.notability,
                     m.lean_verified, m.origin, m.origin_source, m.names, m.created_at, e.rel, ec.tier as edge_tier,
                     row_number() over (partition by e.dst order by ec.tier desc, m.notability desc) as rn
              from edge e join contribution ec on ec.id = e.contribution_id
              join contribution_overview m on m.id = e.src
              where e.dst = any (${ids}::uuid[]) and ec.status = 'active' and m.status = 'active'
                and e.rel = any (${PROGRESS_RELS})) t
            where rn <= 3`,
        sql`select * from (
              select e.src as q, t.id, t.kind, t.title, t.summary, t.tier, t.state, t.notability,
                     t.lean_verified, t.origin, t.origin_source, t.names, t.created_at,
                     row_number() over (partition by e.src order by t.notability desc) as rn
              from edge e join contribution ec on ec.id = e.contribution_id
              join contribution_overview t on t.id = e.dst
              where e.src = any (${ids}::uuid[]) and ec.status = 'active' and t.status = 'active'
                and e.rel = any (${SUB_RELS}) and t.kind in ('problem', 'conjecture')
                and t.state is distinct from 'settled') s
            where rn <= 3`,
        sql`select * from (
              select e.dst as q, r.title, r.state, r.metadata,
                     row_number() over (partition by e.dst order by (r.state = 'open') desc, r.notability desc) as rn
              from edge e join contribution ec on ec.id = e.contribution_id
              join contribution_overview r on r.id = e.src
              where e.dst = any (${ids}::uuid[]) and ec.status = 'active' and r.status = 'active'
                and r.kind = 'route' and e.rel in ('attacks', 'about', 'serves')) t
            where rn <= 4`,
        sql`select e.src as q, f.id, f.title from edge e
            join contribution ec on ec.id = e.contribution_id
            join contribution f on f.id = e.dst
            where e.src = any (${ids}::uuid[]) and e.rel = 'in-front'
              and ec.status = 'active' and f.status = 'active'`,
        sql`select * from (
              select cid.c as q, t.id as trail_id, t.title, i.display_name as by, t.updated_at as last_activity,
                     (select note from trail_entry where trail_id = t.id order by id desc limit 1) as latest_note,
                     row_number() over (partition by cid.c order by t.updated_at desc) as rn
              from trail t join identity i on i.id = t.identity_id
              join trail_entry te on te.trail_id = t.id
              join lateral unnest(te.contribution_ids) as cid(c) on true
              where cid.c = any (${ids}::uuid[]) and t.status = 'open'
                and t.updated_at > now() - ${TRAIL_FRESH}::interval
              group by cid.c, t.id, t.title, i.display_name, t.updated_at) x
            where rn <= 2`,
        sql`select * from (
              select cid.c as q, t.id as trail_id, t.title, t.metadata->>'outcome' as outcome,
                     t.updated_at as ended_at,
                     (select note from trail_entry where trail_id = t.id order by id desc limit 1) as last_note,
                     row_number() over (partition by cid.c order by t.updated_at desc) as rn
              from trail t join trail_entry te on te.trail_id = t.id
              join lateral unnest(te.contribution_ids) as cid(c) on true
              where cid.c = any (${ids}::uuid[]) and t.status = 'closed'
              group by cid.c, t.id, t.title, t.metadata, t.updated_at) x
            where rn <= 2`,
      ])
    : [[], [], [], [], [], []];

  const per = <T extends { q: string }>(rows: readonly T[], id: string) => rows.filter((r) => r.q === id);

  const questionRows = chosen.map((row) => {
    const id = row.id as string;
    const stalls = per(routes as { q: string; title: string; state: string; metadata: Record<string, string> | null }[], id)
      .filter((r) => r.metadata?.first_unsupported)
      .map((r) => ({ route: r.title, state: r.state, stalls_at: trim(r.metadata!.first_unsupported!, LIST_NOTE) }));
    return {
      ...listRow(row),
      in_programmes: per(fronts as { q: string; id: string; title: string }[], id).map((f) => ({ id: f.id, title: f.title })),
      activity_this_window: touched.get(id) ?? {},
      progress_toward_it: per(progress as { q: string }[], id).map(listRow),
      open_subproblems: per(subproblems as { q: string }[], id).map(listRow),
      where_routes_stall: stalls,
      exploring_now: per(exploring as { q: string; trail_id: string; title: string; by: string | null; latest_note: string | null; last_activity: Date }[], id)
        .map((t) => ({
          trail_id: t.trail_id, title: t.title, by: t.by,
          latest_note: trim(t.latest_note, LIST_NOTE), last_activity: t.last_activity,
        })),
      already_tried: per(tried as { q: string; trail_id: string; title: string; outcome: string | null; ended_at: Date; last_note: string | null }[], id)
        .map((t) => ({ trail_id: t.trail_id, title: t.title, outcome: t.outcome, ended_at: t.ended_at, last_note: trim(t.last_note, LIST_NOTE) })),
    };
  });

  return {
    window: {
      from_seq: from,
      to_seq: head,
      events: span!.events,
      from_at: span!.from_at,
      to_at: span!.to_at,
    },
    totals,
    movement: {
      new_entries: rels(newEntries),
      new_links: rels(newLinks),
      event_kinds: Object.fromEntries(eventKinds.map((r) => [r.kind, r.n])),
      by_identity: identities.map((r) => ({ identity_id: r.identity_id, name: r.display_name, events: r.n })),
    },
    settled: Object.values(settled).slice(0, limit),
    promoted: promoted.map((row) => ({
      entry: listRow(row), tier: row.promoted_to, note: trim(row.note as string | null, LIST_NOTE), at: row.at,
    })),
    promotions: { total: promotionCounts!.total, links: promotionCounts!.links },
    kernel_checks: {
      passed: verificationCounts!.passed,
      failed: verificationCounts!.failed,
      // A Lean file can declare a hundred lemmas on the way to its theorem.
      // The names are here to say what was proved, not to reproduce the file.
      proved: verified.map((row) => ({
        entry: listRow(row),
        decls: (row.decls as string[]).slice(0, DECLS_SHOWN),
        ...((row.decls as string[]).length > DECLS_SHOWN ? { decls_beyond: (row.decls as string[]).length - DECLS_SHOWN } : {}),
        at: row.at,
      })),
    },
    terminal: {
      total: terminalTotal!.n,
      decisions: terminal.map((row) => ({
        decision: row.decision, entry: listRow(row), note: trim(row.note as string | null, LIST_NOTE), at: row.at,
      })),
    },
    questions: questionRows,
    questions_open_elsewhere: Math.max(0, openCount!.n - questionRows.length),
    next: { after_seq: head },
    how_to_read: HOW_TO_READ,
  };
}
