import type { TransactionSql } from "postgres";
import { onBoard, sql, windowColumn, withoutExternalResults } from "./db.ts";
import { sha256hex } from "./identity.ts";
import { clusterBySimilarity, rankBySimilarity } from "./ncd.ts";

/** The handle a sql.begin callback receives. Spelled out, because
 *  sql.begin is overloaded and inferring it lands on `never`. */
export type Tx = TransactionSql;

// --- Text normalization ------
// Fold every unicode dash/minus to ascii '-' and NFKD-lower, so a query typed
// with a hyphen matches a corpus written with an en-dash ("de Bruijn–Newman").
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u2010-\u2015\u2212\u2043\uFE58\uFE63\uFF0D]/g, "-")
    .toLowerCase();
}

/** Query lexemes, split into required phrases and salient terms. */
function queryParts(q: string): { all: string; any: string } {
  const norm = normalizeText(q);
  const phrases = [...norm.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean);
  const rest = norm.replace(/"[^"]*"/g, " ");
  const terms = [...new Set(rest.split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  const phraseQ = phrases.map((p) => `(${p.split(/[^a-z0-9]+/).filter(Boolean).join(" <-> ")})`);
  const atoms = [...phraseQ, ...terms];
  return {
    all: atoms.length ? atoms.join(" & ") : "zzzznomatchzzzz",
    any: atoms.length ? atoms.join(" | ") : "zzzznomatchzzzz",
  };
}

// --- Degrading search ------
// Two demands pull against each other: a multi-word query must not be swamped
// by entries that merely share its commonest word, and a query that matches
// nothing exactly must still return the nearest thing rather than silence. So
// everything loosely related stays eligible, but rows carrying every term (or
// an exact "quoted phrase") rank in a band above rows carrying only some, and
// each row reports which band it came from. A reader can then stop at the
// first weak match instead of mistaking the tail for more of the same.
export type SearchArgs = {
  query: string;
  kind?: string | string[];
  state?: string;
  topic?: string;
  front?: string;
  lean_verified?: boolean;
  min_tier?: number;
  origin?: "ledger" | "external";
  board?: boolean;
  exclude_external?: boolean;
  since?: Date;
  include_inactive?: boolean;
  limit: number;
  offset: number;
};

// Everything a query can match lives on `contribution.search`: title and
// summary at weight A, the artifact body at weight D. That is what makes the
// eligibility test a single-table OR, which Postgres answers as a BitmapOr
// across the full-text and trigram indexes. Spread across two tables (the
// body's tsvector on `artifact`) the same OR has no plan but a hash join of
// the entire corpus followed by a filter: 1.06 s and 1.3 GB of buffer traffic
// per search, measured, against ~10 ms now.
//
// The A/D weighting also replaced a hand-rolled `rank(title) * 2 + rank(body)`
// with the thing ts_rank already does, so a title hit still outranks a passing
// mention in a body without ranking having to know where the text came from.
const RANK_WEIGHTS = "{0.05, 0.2, 0.4, 1.0}";

export async function searchContributions(args: SearchArgs) {
  const { all, any } = queryParts(args.query);
  const raw = normalizeText(args.query);
  const kinds = args.kind === undefined ? null : Array.isArray(args.kind) ? args.kind : [args.kind];
  const need = args.offset + args.limit;

  // Every filter that is not about matching text, shared by both passes so
  // they cannot drift apart.
  const filters = sql`
        c.kind <> 'edge'
    and (${kinds}::text[] is null or c.kind = any(${kinds}))
    and (${args.state ?? null}::text is null or c.state = ${args.state ?? null})
    and (${args.topic ?? null}::text is null or c.tags @> array[${args.topic ?? null}]::text[])
    and (${args.lean_verified ?? null}::bool is null or c.lean_verified = ${args.lean_verified ?? false})
    and (${args.min_tier ?? null}::int is null or c.tier >= ${args.min_tier ?? 0})
    and (${args.origin ?? null}::text is null or c.origin = ${args.origin ?? null})
    and (not ${args.board ?? false}::bool or (${onBoard()}))
    and (not ${args.exclude_external ?? false}::bool or (${withoutExternalResults()}))
    and (${args.since ?? null}::timestamptz is null or ${windowColumn(args.board)} >= ${args.since ?? null})
    and (${args.include_inactive ?? false} or c.status = 'active')
    and (${args.front ?? null}::uuid is null or exists (
          select 1 from edge e join contribution ec on ec.id = e.contribution_id
          where e.src = c.id and e.dst = ${args.front ?? null}::uuid
            and e.rel = 'in-front' and ec.status = 'active'))`;

  const columns = sql`c.id, c.kind, c.title, c.summary, c.tier, c.status, c.state, c.tags, c.names,
                      c.created_at, c.board_at, c.lean_verified, c.notability, c.origin, c.origin_source`;

  // Pass one: the text index. A query whose terms appear anywhere in the
  // corpus is answered entirely here, off contribution_search_idx.
  const matched = await sql`
    with hit as (
      select ${columns},
             c.search @@ to_tsquery('english', ${all}) as complete,
             ts_rank(${RANK_WEIGHTS}::float4[], c.search, to_tsquery('english', ${any})) as text_rank
      from contribution c
      where c.search @@ to_tsquery('english', ${any}) and ${filters})
    select id, kind, title, summary, tier, status, state, tags, names, created_at, board_at,
           lean_verified, notability, origin, origin_source,
           case when complete then 'every term' else 'some terms' end as matched,
           round(text_rank::numeric, 4)::float8 as score
    from hit
    order by complete desc,
             text_rank * (1 + 0.2 * ln(1 + greatest(notability, 0))) desc,
             created_at desc
    limit ${need}`;

  // Pass two, only when the index came up short: the promise this tool makes
  // is that a misspelling degrades rather than returning nothing, and this is
  // where that gets paid for. It is deliberately not OR-ed into the pass
  // above. As one predicate the planner had to satisfy both branches for
  // every row, and trigram similarity over title+summary at a 0.2 threshold
  // returns a quarter of the corpus as candidates and rechecks each one:
  // 2.1 s to contribute two rows, on every search, including the ones the
  // text index had already answered in 25 ms. Restricted to titles it is
  // ~80 ms and finds more of what a misspelling was reaching for, because a
  // misremembered name is a name.
  if (matched.length >= need) return matched.slice(args.offset);

  const seen = matched.map((r) => r.id as string);
  const fuzzy = await sql.begin(async (tx: Tx) => {
    await tx`select set_config('pg_trgm.similarity_threshold', '0.2', true)`;
    return tx`
      select ${columns},
             'fuzzy' as matched,
             round(greatest(similarity(lower(c.title), ${raw}),
                            word_similarity(${raw}, c.names_text))::numeric, 4)::float8 as score
      from contribution c
      where (lower(c.title) % ${raw} or ${raw} <% c.names_text)
        and not (c.id = any(${seen}::uuid[]))
        and ${filters}
      order by score desc, c.notability desc, c.created_at desc
      limit ${need - matched.length}`;
  });

  return [...matched, ...fuzzy].slice(args.offset);
}

// --- Semantic embeddings ------
// Query-time embedding via the local embedding server (contributions are
// embedded by the background worker). Returns null if the embedder is down or
// warming up, so callers degrade to NCD/lexical rather than failing.
const EMBEDDER_URL = process.env.EMBEDDER_URL ?? "http://127.0.0.1:8090";

export async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${EMBEDDER_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text.slice(0, 1400) }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { embedding: number[] }[] };
    return j.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

const asVector = (a: number[]): string => `[${a.join(",")}]`;

// --- Notability ------
export async function refreshNotability(ids?: string[]): Promise<void> {
  if (ids && ids.length === 0) return;
  await sql`select refresh_notability(${ids ?? null}::uuid[])`;
}

/** Recompute whether questions are answered. Cheap, and run wherever an edge
 *  or a status could have changed the answer. */
export async function refreshState(ids?: string[]): Promise<void> {
  if (ids && ids.length === 0) return;
  await sql`select refresh_state(${ids ?? null}::uuid[])`;
}

/** What one write can have changed: these entries, and one hop out. Use this
 *  after a write; a full refresh belongs only to a tuning change. */
export async function refreshAround(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await sql`select refresh_around(${ids}::uuid[])`;
}

// --- Edges are contributions ------
// Creating a link inserts a kind='edge' contribution (its own author, tier 0,
// metadata) plus the structural sidecar row. Same identity asserting the same
// (src,dst,rel) twice is idempotent; different identities asserting it are
// independent contributions, which is the signal that a link is corroborated.
export async function createEdge(
  tx: Tx,
  e: { identityId: string | null; src: string; dst: string; rel: string; note?: string; metadata?: Record<string, unknown> },
): Promise<{ id: string } | { skipped: string }> {
  if (e.src === e.dst) return { skipped: "self-link" };
  const [dup] = await tx<{ id: string }[]>`
    select e.contribution_id as id from edge e join contribution c on c.id = e.contribution_id
    where e.src = ${e.src} and e.dst = ${e.dst} and e.rel = ${e.rel}
      and c.identity_id is not distinct from ${e.identityId} and c.status = 'active' limit 1`;
  if (dup) return { skipped: dup.id };

  const content = (e.note?.trim() || e.rel).slice(0, 4000);
  const hash = sha256hex(`edge:${e.src}:${e.dst}:${e.rel}:${content}`);
  const metadata = { ...(e.metadata ?? {}), src: e.src, dst: e.dst, rel: e.rel };
  await tx`insert into artifact (hash, media_type, content, size_bytes)
           values (${hash}, 'text/plain', ${content}, ${Buffer.byteLength(content)})
           on conflict do nothing`;
  const [c] = await tx<{ id: string }[]>`
    insert into contribution (kind, title, summary, artifact_hash, metadata, identity_id)
    values ('edge', ${e.rel}, ${e.note?.trim() || `${e.rel} link`}, ${hash},
            ${tx.json(metadata as never)}, ${e.identityId})
    returning id`;
  await tx`insert into edge (contribution_id, src, dst, rel) values (${c!.id}, ${e.src}, ${e.dst}, ${e.rel})`;
  await tx`insert into event (kind, contribution_id, identity_id, payload)
           values ('submitted', ${c!.id}, ${e.identityId},
                   ${tx.json({ kind: "edge", src: e.src, dst: e.dst, rel: e.rel } as never)})`;
  return { id: c!.id };
}

// --- Typed neighbourhood ------
// The context door: what a contribution connects to, grouped by relation and
// direction, each link carrying the edge's own tier so a reader can tell a
// trusted-reviewed connection from a freshly asserted one. No lexical
// substitution. An empty neighbourhood is an honest gap, not filler.
//
// Each link also carries `linked_at`, the moment the connection was asserted.
// That is the edge's own fact and exists nowhere else in the read surface: a
// claim made an hour ago and one standing since the graph began look identical
// without it, and "is this connection fresh?" is a question about the edge,
// not about either endpoint.
// A hub entry can have hundreds of neighbours, and shipping them all made one
// `get` cost more than the rest of a session combined (506 rows, 136 KB,
// observed live). So each relation shows its top rows by (edge tier,
// notability) and reports how many it is not showing in `more`; a caller who
// wants the rest pages one relation with `rel`/`offset`, or reaches for the
// query tool. The 507th neighbour is never worth inline tokens unasked.
//
// A link to a retracted, superseded, or rejected entry is a dead link: three
// near-identical copies of one withdrawn paper crowding a relation tell a
// reader nothing the surviving copy does not. So the neighbourhood keeps only
// active endpoints, with one exception: `supersedes` exists to name what was
// replaced, so retiring its target is the relation working, not noise. The
// full history stays reachable through the query tool (q_links).
export const NEIGHBOUR_CAP = 8;

export async function neighbourhood(id: string, opts?: { rel?: string; offset?: number; limit?: number }) {
  const rel = opts?.rel ?? null;
  const out = await sql`
    select e.rel, e.dst as id, c.kind, c.title, c.tier, c.notability, c.status,
           ec.tier as edge_tier, ec.identity_id as asserted_by, e.created_at as linked_at
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution c on c.id = e.dst
    where e.src = ${id} and ec.status = 'active' and (${rel}::text is null or e.rel = ${rel})
      and (c.status = 'active' or e.rel = 'supersedes')
    order by ec.tier desc, c.notability desc`;
  const incoming = await sql`
    select e.rel, e.src as id, c.kind, c.title, c.tier, c.notability, c.status,
           ec.tier as edge_tier, ec.identity_id as asserted_by, e.created_at as linked_at
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution c on c.id = e.src
    where e.dst = ${id} and ec.status = 'active' and (${rel}::text is null or e.rel = ${rel})
      and (c.status = 'active' or e.rel = 'supersedes')
    order by ec.tier desc, c.notability desc`;
  const group = (rows: typeof out) =>
    rows.reduce<Record<string, unknown[]>>((acc, r) => {
      (acc[r.rel] ??= []).push({
        id: r.id, kind: r.kind, title: r.title, tier: r.tier, edge_tier: r.edge_tier,
        ...(r.status === "active" ? {} : { status: r.status }),
      });
      return acc;
    }, {});
  const offset = rel ? (opts?.offset ?? 0) : 0;
  const cap = rel ? (opts?.limit ?? 50) : NEIGHBOUR_CAP;
  const shape = (grouped: Record<string, unknown[]>) => {
    const kept: Record<string, unknown[]> = {};
    const more: Record<string, number> = {};
    for (const [r, rows] of Object.entries(grouped)) {
      const page = rows.slice(offset, offset + cap);
      if (page.length) kept[r] = page;
      const rest = rows.length - offset - page.length;
      if (rest > 0) more[r] = rest;
    }
    return { kept, more };
  };
  const o = shape(group(out));
  const i = shape(group(incoming));
  const more = {
    ...(Object.keys(o.more).length ? { out: o.more } : {}),
    ...(Object.keys(i.more).length ? { in: i.more } : {}),
  };
  return { out: o.kept, in: i.kept, ...(Object.keys(more).length ? { more } : {}) };
}

// --- Similarity oracle (NCD) ------
// On-demand relatedness, never a stored backlog. A bounded pool of candidates
// is nominated, and the method says how to rank it: cosine over the
// embedding, term overlap, or alpha-normalized NCD, which replaces variables,
// constants and names by their first-occurrence position, then takes compression distance
// over what is left, so two entries doing the same thing with different
// letters score as what they are. Agents call this, look, and decide what to
// link. The tool proposes nothing on its own.
//
// Nomination is by nearest embedding, because an entry is not a query: an OR
// over the terms of a write-up matches a third of the corpus, and Postgres
// answers it by sequentially scanning and ranking all of it, 128ms typically and
// 33 seconds for entries whose vocabulary is common. The vector index returns
// a fixed 150 in milliseconds no matter what the entry says. Term matching
// stays available as `lexical`, where the probe is a title or a phrase the
// caller typed, which is short by construction.
//
// Normalization and compression both run in a worker (see ncd.ts): together
// they are the only unbroken stretch of CPU in request handling, and on a
// single-threaded runtime that stretch is 150 units long.
export type RelatedArgs = { id?: string; text?: string; method: "ncd" | "lexical" | "semantic"; limit: number };

export async function related(args: RelatedArgs) {
  let queryText: string;
  /** The body alone, which is what compression distance compares. */
  let ncdQuery: string;
  /** The title line, for the lexical probe. */
  let aboutText: string;
  let selfId: string | null = null;
  let embedded = false;
  if (args.id) {
    const [row] = await sql<{ content: string; title: string; summary: string; embedded: boolean }[]>`
      select a.content, c.title, c.summary, c.embedding is not null as embedded from contribution c
      join artifact a on a.hash = c.artifact_hash where c.id = ${args.id}`;
    if (!row) return { error: "no contribution with that id" };
    selfId = args.id;
    embedded = row.embedded;
    queryText = `${row.title}\n${row.summary}\n${row.content}`;
    ncdQuery = row.content;
    aboutText = `${row.title}\n${row.summary}`;
  } else if (args.text) {
    queryText = args.text;
    ncdQuery = args.text;
    aboutText = args.text;
  } else {
    return { error: "pass an id or some text to find things related to." };
  }

  const wantsContent = args.method === "ncd";
  // An entry that is already embedded is its own probe: re-embedding its text
  // recomputes a vector that is already sitting in the row.
  //
  // Resolved to a value rather than a SQL fragment because the query below
  // needs it twice, once to score and once to order, and a fragment is
  // consumed by its first interpolation -- the second came out as a bare `$1`
  // and every semantic `related` call failed with "syntax error at or near
  // $1". A bound value can be interpolated as many times as it is needed, and
  // a literal vector on both branches is also what pgvector wants on the
  // order-by operand for the HNSW index to be used.
  const probeVector: string | null =
    args.method === "lexical" ? null
    : embedded
      ? (await sql<{ v: string }[]>`select embedding::text as v from contribution where id = ${selfId}::uuid`)[0]?.v ?? null
      : await embed(queryText).then((v) => (v ? asVector(v) : null));
  if (!probeVector && args.method === "semantic") {
    return { error: "semantic search is warming up, so use method 'ncd' or 'lexical' for now." };
  }

  type Candidate = { id: string; content: string | null; similarity?: number } & Record<string, unknown>;
  let candidates: Candidate[];
  if (probeVector) {
    candidates = await sql<Candidate[]>`
      select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified, c.origin, c.origin_source, c.created_at,
             round((1 - (c.embedding <=> ${probeVector}::vector))::numeric, 4)::float8 as similarity,
             case when ${wantsContent} then left(a.content, 4000) end as content
      from contribution c left join artifact a on ${wantsContent} and a.hash = c.artifact_hash
      where c.kind <> 'edge' and c.status = 'active' and c.embedding is not null
        and (${selfId}::uuid is null or c.id <> ${selfId})
      order by c.embedding <=> ${probeVector}::vector
      limit ${wantsContent ? 150 : args.limit}`;
  } else {
    // Words, for the caller who asked for words: a title or a typed phrase,
    // and the trigram index over `lower(title)` for the one they misspelled.
    // Every term is demanded first, because ranking an OR of common terms
    // means ranking a third of the corpus, 300ms against 2ms, and the loose
    // query is only worth running when the strict one comes back short.
    const probeText = (args.text ?? aboutText.split("\n")[0] ?? "").slice(0, 300);
    const { all, any } = queryParts(probeText);
    const probe = normalizeText(probeText).slice(0, 100);
    const want = wantsContent ? 150 : args.limit;
    // The loose pass ranks a pool rather than the corpus: the most notable
    // entries carrying any of the terms, and ts_rank sorts those. Ranking the
    // whole match set costs 300ms because "any of these terms" is a third of
    // the corpus, and the tail of that ranking was never going to be read.
    const POOL = 400;
    const nominate = (tsq: string, fuzzy: boolean) =>
      sql.begin(async (tx: Tx) => {
        if (fuzzy) await tx`select set_config('pg_trgm.similarity_threshold', '0.15', true)`;
        return tx<Candidate[]>`
          select p.*, case when ${wantsContent} then left(a.content, 4000) end as content
          from (
            select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.notability, c.lean_verified,
                   c.origin, c.origin_source, c.created_at, c.search, c.artifact_hash
            from contribution c
            where c.kind <> 'edge' and c.status = 'active'
              and (${selfId}::uuid is null or c.id <> ${selfId})
              and (c.search @@ to_tsquery('english', ${tsq}) or (${fuzzy} and lower(c.title) % ${probe}))
            order by c.notability desc
            limit ${fuzzy ? POOL : want}
          ) p left join artifact a on ${wantsContent} and a.hash = p.artifact_hash
          order by ts_rank(${RANK_WEIGHTS}::float4[], p.search, to_tsquery('english', ${tsq})) desc, p.notability desc
          limit ${want}`;
      });

    candidates = await nominate(all, false);
    if (candidates.length < want) {
      const seen = new Set(candidates.map((c) => c.id));
      candidates = [...candidates, ...(await nominate(any, true)).filter((c) => !seen.has(c.id))].slice(0, want);
    }
  }

  let scored: (Record<string, unknown> & { id: string; similarity?: number })[] = candidates.map(
    ({ content: _content, ...c }) => c as Record<string, unknown> & { id: string },
  );
  if (wantsContent) {
    const byId = new Map(
      (await rankBySimilarity({
        mode: "prose",
        // Compression distance compares like with like. Candidates are scored
        // on their body alone, so an entry used as the query is scored on its
        // body alone too: charging C(x) for a title and summary no candidate
        // paid for made the distance asymmetric and pushed real duplicates
        // down the ranking.
        query: ncdQuery,
        candidates: candidates.map((c) => ({ id: c.id, text: c.content ?? "" })),
      })).map((s) => [s.id, s.similarity]),
    );
    scored = scored.map((c) => ({ ...c, similarity: byId.get(c.id) ?? 0 }));
    scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }
  const top = scored.slice(0, args.limit);

  // Show which candidates are already linked to the query id, so the caller
  // proposes new links rather than duplicating existing ones.
  if (selfId && top.length) {
    const ids = top.map((t) => t.id);
    const existing = await sql<{ other: string; rel: string; edge_tier: number }[]>`
      select case when e.src = ${selfId} then e.dst else e.src end as other, e.rel, ec.tier as edge_tier
      from edge e join contribution ec on ec.id = e.contribution_id
      where ec.status = 'active' and (e.src = ${selfId} or e.dst = ${selfId})
        and (e.src = any(${ids}::uuid[]) or e.dst = any(${ids}::uuid[]))`;
    const byOther = new Map<string, { rel: string; edge_tier: number }[]>();
    for (const x of existing) (byOther.get(x.other) ?? byOther.set(x.other, []).get(x.other)!).push({ rel: x.rel, edge_tier: x.edge_tier });
    return { method: args.method, related: top.map((t) => ({ ...t, existing_links: byOther.get(t.id) ?? [] })) };
  }
  return { method: args.method, related: top };
}

// --- Sweeping the corpus for repeated work ------
// `related` answers "what is near this one?", which is the question you ask
// holding an entry. Consolidation asks the other one: which entries in this
// slice of the corpus are saying the same thing as each other, nobody in
// particular being the query. Pairwise that is quadratic in the slice, so the
// worker buckets by shingle sketch over the normalized form first and pays
// compression distance only inside a bucket, exactly as the Lean scan does.
//
// The slice is bounded and paged rather than corpus-wide in one call, because
// the whole active corpus is ~58k bodies and normalizing them is seconds of
// CPU. Pages run in creation order: duplicates here overwhelmingly come from
// one campaign filing the same result twice within an hour, so time is where
// the locality is, and a caller who wants topical locality passes `topic`.

export type DuplicateScanArgs = {
  kind?: string | string[];
  state?: string;
  topic?: string;
  front?: string;
  min_tier?: number;
  since?: Date;
  threshold: number;
  limit: number;
  offset: number;
};

/** How many entries one page of the sweep normalizes and buckets. Measured by
 *  `test/similarity-bench.ts --task=sweep`: 1.1s of worker time and ~10 MB of
 *  bodies at this corpus's lengths, so six pages cover everything active. */
const SCAN_PAGE = 12000;

type ScanRow = Record<string, unknown> & { id: string; content: string | null };

export async function scanDuplicateEntries(args: DuplicateScanArgs) {
  const kinds = args.kind === undefined ? null : Array.isArray(args.kind) ? args.kind : [args.kind];
  const rows = await sql<ScanRow[]>`
    select p.id, p.kind, p.title, p.summary, p.tier, p.state, p.tags, p.names, p.created_at,
           p.notability, p.lean_verified, p.origin, p.origin_source, left(a.content, 4000) as content
    from (
      select c.id, c.kind, c.title, c.summary, c.tier, c.state, c.tags, c.names, c.created_at,
             c.notability, c.lean_verified, c.origin, c.origin_source, c.artifact_hash
      from contribution c
      where c.kind <> 'edge' and c.status = 'active'
        and (${kinds}::text[] is null or c.kind = any(${kinds}))
        and (${args.state ?? null}::text is null or c.state = ${args.state ?? null})
        and (${args.topic ?? null}::text is null or c.tags @> array[${args.topic ?? null}]::text[])
        and (${args.min_tier ?? null}::int is null or c.tier >= ${args.min_tier ?? 0})
        and (${args.since ?? null}::timestamptz is null or c.created_at >= ${args.since ?? null})
        and (${args.front ?? null}::uuid is null or exists (
              select 1 from edge e join contribution ec on ec.id = e.contribution_id
              where e.src = c.id and e.dst = ${args.front ?? null}::uuid
                and e.rel = 'in-front' and ec.status = 'active'))
      order by c.created_at, c.id
      limit ${SCAN_PAGE} offset ${args.offset}
    ) p join artifact a on a.hash = p.artifact_hash`;

  if (rows.length === 0) {
    return {
      scanned: 0,
      compared: 0,
      threshold: args.threshold,
      pairs: [],
      note: "nothing active matched those filters, or the offset is past the end of the slice.",
    };
  }

  const index = new Map(rows.map((row, i) => [String(i), row]));
  const { pairs, compared } = await clusterBySimilarity({
    mode: "prose",
    units: rows.map((row, i) => ({ id: String(i), text: row.content ?? "" })),
    threshold: args.threshold,
    limit: args.limit,
  });

  // A pair the corpus already knows about is not a finding. Whatever links
  // exist between the two are reported on the pair, so a sweep run again next
  // week skips what the last one already consolidated instead of proposing it
  // a second time.
  const ids = [...new Set(pairs.flatMap((p) => [index.get(p.a)!.id, index.get(p.b)!.id]))];
  const linked = ids.length
    ? await sql<{ src: string; dst: string; rel: string; edge_tier: number }[]>`
        select e.src, e.dst, e.rel, ec.tier as edge_tier
        from edge e join contribution ec on ec.id = e.contribution_id
        where ec.status = 'active' and e.src = any(${ids}::uuid[]) and e.dst = any(${ids}::uuid[])`
    : [];
  const between = new Map<string, { rel: string; edge_tier: number }[]>();
  for (const e of linked) {
    for (const key of [`${e.src}|${e.dst}`, `${e.dst}|${e.src}`]) {
      (between.get(key) ?? between.set(key, []).get(key)!).push({ rel: e.rel, edge_tier: e.edge_tier });
    }
  }

  const scored = pairs.map((pair) => {
    const a = index.get(pair.a)!;
    const b = index.get(pair.b)!;
    const existing = between.get(`${a.id}|${b.id}`) ?? [];
    return { similarity: pair.similarity, a, b, ...(existing.length ? { existing_links: existing } : {}) };
  });

  return {
    scanned: rows.length,
    compared,
    threshold: args.threshold,
    pairs: scored,
    ...(rows.length === SCAN_PAGE ? { next_offset: args.offset + SCAN_PAGE } : {}),
    note: scored.length
      ? "These pairs share structure after alpha normalization, which is an attention list and not a proof that they say the same thing. Read both before proposing anything. Where they are two tellings of one result, the repair is one entry superseding both; where they are rungs of one ladder, it is the general statement they are all instances of."
      : "Nothing in this page scored above the threshold. Lower it to see weaker echoes, or page on with next_offset.",
  };
}
