import { impactScore, onBoard, sql } from "./db.ts";
import { listRow } from "./read.ts";
import { Refreshing } from "./refreshing.ts";

// --- The corpus at a glance ------
// hello and news both open with the same question, how big is this place and
// what is worth looking at, and both used to answer it by re-aggregating the
// whole corpus per call: six full scans for hello (178 ms) and one more for
// news's totals (198 ms). None of it moves faster than a submission, so it is
// derived once for everyone on a short cycle instead of once per caller.

const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS ?? 30_000);
const TRAIL_FRESH = "2 hours";

export type KindShape = { kind: string; n: number; states: Record<string, number> | null };
export type Programme = { id: string; title: string; members: number; open_problems: number };

export type CorpusSnapshot = {
  kinds: KindShape[];
  by_tier: { tier: number; n: number }[];
  top_topics: { topic: string; n: number }[];
  programmes: Programme[];
  established_here: ReturnType<typeof listRow>[];
  most_notable: ReturnType<typeof listRow>[];
  fresh_canon: ReturnType<typeof listRow>[];
  totals: {
    entries: number;
    links: number;
    programmes: number;
    open_questions: number;
    lean_verified: number;
    active_trails: number;
  };
};

/** A row as an orientation door shows it. hello says what is here and points
 *  at the doors that fetch it; it is not a reading surface. Eighteen rows of
 *  full summaries made the whole answer 21 KB, and past about 16 KB a common
 *  client replaces a tool result with a notice pointing at a temp file -- so
 *  the first call an agent makes here came back with nothing in it. */
const GLANCE_SUMMARY = 160;
function glance(r: Record<string, unknown>) {
  const row = listRow(r) as Record<string, unknown>;
  const summary = row.summary as string | undefined;
  if (summary && summary.length > GLANCE_SUMMARY) {
    row.summary = `${summary.slice(0, GLANCE_SUMMARY).trimEnd()}…`;
  }
  return row;
}

async function computeSnapshot(): Promise<CorpusSnapshot> {
  // One pass over the corpus feeds every count, instead of one scan per
  // headline. The state vocabulary differs by kind, since a route is partial or
  // refuted while a problem is open or settled, so report what is actually there
  // rather than a fixed pair of columns that reads as "0 settled routes".
  const [shape, programmes, board, notable, fresh, trails] = await Promise.all([
    sql<{ kind: string; state: string | null; tier: number | null; n: number; lean: number }[]>`
      select kind, state, tier, count(*)::int as n, count(*) filter (where lean_verified)::int as lean
      from contribution where status = 'active' group by kind, state, tier`,
    sql<{ id: string; title: string; members: number; open_problems: number }[]>`
      select f.id, f.title,
             count(*) filter (where m.id is not null)::int as members,
             count(*) filter (where m.kind = 'problem' and m.state = 'open')::int as open_problems
      from contribution f
      left join edge e on e.dst = f.id and e.rel = 'in-front'
      left join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
      left join contribution m on m.id = e.src and m.status = 'active' and ec.id is not null
      where f.kind = 'front' and f.status = 'active'
      group by f.id, f.title, f.notability
      order by members desc, f.notability desc limit 10`,
    // What this place has actually established, best first, which is the
    // first thing anyone arriving wants and the one thing graph density
    // cannot answer.
    sql`select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified,
               c.origin, c.origin_source, c.created_at, c.board_at, ${impactScore()} as impact_score
        from contribution c
        where c.status = 'active' and ${onBoard()}
        order by impact_score desc, c.notability desc, c.created_at desc limit 5`,
    sql`select id, kind, title, summary, tier, state, notability, lean_verified, origin, origin_source, created_at
        from contribution
        where status = 'active' and kind not in ('edge', 'statement')
        order by notability desc, created_at desc limit 6`,
    sql`select id, kind, title, summary, tier, state, notability, lean_verified, origin, origin_source, created_at
        from contribution
        where status = 'active' and kind <> 'edge' and tier >= 2
        order by created_at desc limit 5`,
    sql<{ n: number }[]>`
      select count(*)::int as n from trail
      where status = 'open' and updated_at > now() - ${TRAIL_FRESH}::interval`,
  ]);

  const kinds = new Map<string, KindShape>();
  const tiers = new Map<number, number>();
  const totals = {
    entries: 0,
    links: 0,
    programmes: 0,
    open_questions: 0,
    lean_verified: 0,
    active_trails: trails[0]!.n,
  };
  for (const row of shape) {
    totals.lean_verified += row.lean;
    if (row.kind === "edge") {
      totals.links += row.n;
      continue;
    }
    totals.entries += row.n;
    if (row.kind === "front") totals.programmes += row.n;
    if ((row.kind === "problem" || row.kind === "conjecture") && row.state === "open") {
      totals.open_questions += row.n;
    }
    // The ladder is over claims. A review has no tier and belongs on no rung
    // of it, so it is counted as a kind and not as a step of review's progress.
    if (row.tier !== null) tiers.set(row.tier, (tiers.get(row.tier) ?? 0) + row.n);
    const entry = kinds.get(row.kind) ?? { kind: row.kind, n: 0, states: null };
    entry.n += row.n;
    if (row.state) (entry.states ??= {})[row.state] = (entry.states[row.state] ?? 0) + row.n;
    kinds.set(row.kind, entry);
  }

  const topTopics = await sql<{ topic: string; n: number }[]>`
    select tag as topic, count(*)::int as n from contribution c, unnest(c.tags) as tag
    where c.status = 'active' and c.kind <> 'edge' group by tag order by n desc limit 12`;

  return {
    kinds: [...kinds.values()].sort((a, b) => b.n - a.n),
    by_tier: [...tiers.entries()].sort((a, b) => a[0] - b[0]).map(([tier, n]) => ({ tier, n })),
    top_topics: topTopics,
    programmes: programmes.map((p) => ({
      id: p.id,
      title: p.title,
      members: Number(p.members),
      open_problems: Number(p.open_problems),
    })),
    established_here: board.map(glance),
    most_notable: notable.map(glance),
    fresh_canon: fresh.map(glance),
    totals,
  };
}

export const corpus = new Refreshing(computeSnapshot, SNAPSHOT_TTL_MS, "corpus snapshot");
