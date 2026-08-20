import { sql } from "./db.ts";
import { sha256hex } from "./identity.ts";

type Tx = Parameters<Parameters<typeof sql.begin>[0]>[0];

// ——— Text normalization ————————————————————————————————————————————————
// Fold every unicode dash/minus to ascii '-' and NFKD-lower, so a query typed
// with a hyphen matches a corpus written with an en-dash ("de Bruijn–Newman").
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u2010-\u2015\u2212\u2043\uFE58\uFE63\uFF0D]/g, "-")
    .toLowerCase();
}

/** Salient lexemes of a query, for an OR tsquery that ranks instead of gating. */
function tsTerms(q: string): string {
  const terms = [...new Set(normalizeText(q).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
  return terms.length ? terms.join(" | ") : "zzzznomatchzzzz";
}

// ——— Degrading search ——————————————————————————————————————————————————
// One query that never returns empty when anything is even loosely related:
// OR-of-terms full-text (so partial term overlap still ranks) unioned with
// trigram similarity (so typos, symbols, and substring names still land),
// ordered by text relevance blended with the notability gradient.
export type SearchArgs = {
  query: string;
  kind?: string;
  min_tier?: number;
  include_inactive?: boolean;
  limit: number;
  offset: number;
};

export async function searchContributions(args: SearchArgs) {
  const tsq = tsTerms(args.query);
  const raw = normalizeText(args.query);
  return sql.begin(async (tx: Tx) => {
    await tx`select set_config('pg_trgm.similarity_threshold', '0.2', true)`;
    return tx`
      select c.id, c.kind, c.title, c.summary, c.tier, c.status, c.created_at,
             c.lean_verified, c.notability,
             ts_rank(c.search, to_tsquery('english', ${tsq}))
               + ts_rank(a.search, to_tsquery('english', ${tsq})) as text_rank,
             similarity(lower(c.title || ' ' || c.summary), ${raw}) as fuzzy
      from contribution_overview c join artifact a on a.hash = c.artifact_hash
      where c.kind <> 'edge'
        and (c.search @@ to_tsquery('english', ${tsq})
             or a.search @@ to_tsquery('english', ${tsq})
             or lower(c.title || ' ' || c.summary) % ${raw})
        and (${args.kind ?? null}::text is null or c.kind = ${args.kind ?? null})
        and (${args.min_tier ?? null}::int is null or c.tier >= ${args.min_tier ?? 0})
        and (${args.include_inactive ?? false} or c.status = 'active')
      order by ((ts_rank(c.search, to_tsquery('english', ${tsq}))
                   + ts_rank(a.search, to_tsquery('english', ${tsq}))) * 3
                + similarity(lower(c.title || ' ' || c.summary), ${raw}) * 2)
               * (1 + 0.2 * ln(1 + greatest(c.notability, 0))) desc,
               c.created_at desc
      limit ${args.limit} offset ${args.offset}`;
  });
}

// ——— Semantic embeddings ———————————————————————————————————————————————
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

// ——— Notability ————————————————————————————————————————————————————————
export async function refreshNotability(ids?: string[]): Promise<void> {
  if (ids && ids.length === 0) return;
  await sql`select refresh_notability(${ids ?? null}::uuid[])`;
}

// ——— Edges are contributions ———————————————————————————————————————————
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

// ——— Typed neighbourhood ———————————————————————————————————————————————
// The context door: what a contribution connects to, grouped by relation and
// direction, each link carrying the edge's own tier so a reader can tell a
// trusted-reviewed connection from a freshly asserted one. No lexical
// substitution — an empty neighbourhood is an honest gap, not filler.
//
// Each link also carries `linked_at`, the moment the connection was asserted.
// That is the edge's own fact and exists nowhere else in the read surface: a
// claim made an hour ago and one standing since the graph began look identical
// without it, and "is this connection fresh?" is a question about the edge,
// not about either endpoint.
export async function neighbourhood(id: string) {
  const out = await sql`
    select e.rel, e.dst as id, c.kind, c.title, c.tier, c.notability, c.status,
           ec.tier as edge_tier, ec.identity_id as asserted_by, e.created_at as linked_at
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution c on c.id = e.dst
    where e.src = ${id} and ec.status = 'active'
    order by ec.tier desc, c.notability desc`;
  const incoming = await sql`
    select e.rel, e.src as id, c.kind, c.title, c.tier, c.notability, c.status,
           ec.tier as edge_tier, ec.identity_id as asserted_by, e.created_at as linked_at
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution c on c.id = e.src
    where e.dst = ${id} and ec.status = 'active'
    order by ec.tier desc, c.notability desc`;
  const group = (rows: typeof out) =>
    rows.reduce<Record<string, unknown[]>>((acc, r) => {
      (acc[r.rel] ??= []).push({
        id: r.id, kind: r.kind, title: r.title, tier: r.tier, notability: r.notability,
        edge_tier: r.edge_tier, status: r.status, linked_at: r.linked_at,
      });
      return acc;
    }, {});
  return { out: group(out), in: group(incoming) };
}

// ——— Similarity oracle (NCD) ———————————————————————————————————————————
// On-demand relatedness, never a stored backlog. A cheap lexical prefilter
// nominates candidates; alpha-normalized NCD (compression distance) ranks how
// much structural information each shares with the query. Agents call this,
// look, and decide what to link — the tool proposes nothing on its own.
function compress(s: string): number {
  return Bun.gzipSync(Buffer.from(s)).length;
}
function ncd(x: string, y: string): number {
  const cx = compress(x), cy = compress(y), cxy = compress(x + "\n" + y);
  return (cxy - Math.min(cx, cy)) / Math.max(cx, cy);
}
function normalizeForNcd(s: string): string {
  return normalizeText(s).replace(/\s+/g, " ").trim().slice(0, 4000);
}

export type RelatedArgs = { id?: string; text?: string; method: "ncd" | "lexical" | "semantic"; limit: number };

export async function related(args: RelatedArgs) {
  let queryText: string;
  let selfId: string | null = null;
  if (args.id) {
    const [row] = await sql<{ content: string; title: string; summary: string }[]>`
      select a.content, c.title, c.summary from contribution c
      join artifact a on a.hash = c.artifact_hash where c.id = ${args.id}`;
    if (!row) return { error: "no contribution with that id" };
    selfId = args.id;
    queryText = `${row.title}\n${row.summary}\n${row.content}`;
  } else if (args.text) {
    queryText = args.text;
  } else {
    return { error: "pass an id or some text to find things related to." };
  }

  if (args.method === "semantic") {
    const v = await embed(queryText);
    if (!v) return { error: "semantic search is warming up — use method 'ncd' or 'lexical' for now." };
    const rows = await sql`
      select co.id, co.kind, co.title, co.tier, co.notability, co.created_at,
             round((1 - (c.embedding <=> ${asVector(v)}::vector))::numeric, 4) as similarity
      from contribution c join contribution_overview co on co.id = c.id
      where c.kind <> 'edge' and co.status = 'active' and c.embedding is not null
        and (${selfId}::uuid is null or c.id <> ${selfId})
      order by c.embedding <=> ${asVector(v)}::vector limit ${args.limit}`;
    return { method: "semantic", related: rows };
  }

  const tsq = tsTerms(queryText);
  const raw = normalizeText(`${queryText}`).slice(0, 300);
  const candidates = await sql.begin(async (tx: Tx) => {
    await tx`select set_config('pg_trgm.similarity_threshold', '0.15', true)`;
    return tx<{ id: string; kind: string; title: string; tier: number; notability: number; created_at: string; content: string }[]>`
      select c.id, c.kind, c.title, c.tier, c.notability, c.created_at, left(a.content, 4000) as content
      from contribution_overview c join artifact a on a.hash = c.artifact_hash
      where c.kind <> 'edge' and c.status = 'active'
        and (${selfId}::uuid is null or c.id <> ${selfId})
        and (c.search @@ to_tsquery('english', ${tsq})
             or lower(c.title || ' ' || c.summary) % ${raw})
      order by ts_rank(c.search, to_tsquery('english', ${tsq})) desc,
               c.notability desc
      limit 150`;
  });

  const q = normalizeForNcd(queryText);
  const scored = candidates.map((c) => ({
    id: c.id, kind: c.kind, title: c.title, tier: c.tier, notability: c.notability, created_at: c.created_at,
    similarity: args.method === "ncd" ? Number((1 - ncd(q, normalizeForNcd(c.content))).toFixed(4)) : undefined,
  }));
  if (args.method === "ncd") scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
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
