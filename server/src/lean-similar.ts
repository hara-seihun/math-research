/**
 * "Has this already been proved, and does the library say it twice?"
 *
 * Two corpora, one question. `lean_decl` is every declaration the pinned
 * libraries provide; `lean_unit` is every declaration the ledger's own checked
 * submissions contain. Both carry an alpha-normalized form of their statement
 * and its hash, so:
 *
 *   - **the same statement, differently named** is an indexed equality on
 *     `norm_hash` — free, exact, and the strongest thing this can say;
 *   - **nearly the same statement** is a trigram prefilter over that same
 *     normalized column (so the prefilter sees structure rather than the names
 *     it is about to discard) followed by alpha-normalized NCD in the worker;
 *   - **a whole namespace at once** is banded-minhash bucketing inside the
 *     worker, so a scan of a module is linear in what is actually similar
 *     rather than quadratic in what it contains.
 *
 * Lean's own generated declarations — `.injEq`, `.mk`, match equations,
 * recursors — are classified out of every answer here. They are structurally
 * identical across every structure with the same field types, nobody wrote
 * them, and nobody can deduplicate them.
 */
import { sql } from "./db.ts";
import type { Tx } from "./graph.ts";
import { clusterBySimilarity, rankBySimilarity } from "./ncd.ts";
import { alphaLean, extractDecls, NORM_VERSION, normalizeDecl, statementForm } from "./similarity.ts";

export type LeanMatch = {
  origin: "library" | "ledger";
  name: string;
  statement: string;
  is_proof: boolean;
  similarity: number;
  exact: boolean;
  module?: string;
  library?: string;
  contribution_id?: string;
  title?: string;
  tier?: number;
};

const PREFILTER = 240;

type DeclRow = {
  origin: "library" | "ledger";
  name: string;
  statement: string;
  is_proof: boolean;
  norm: string;
  norm_hash: string;
  module?: string;
  library?: string;
  contribution_id?: string;
  title?: string;
  tier?: number;
};

/** Rows whose normalized statement is character-for-character the query's. */
const exactMatches = (normHash: string, limit: number) => sql<DeclRow[]>`
  (select 'library' as origin, d.name, d.statement, d.is_proof, d.norm, d.norm_hash,
          d.module, d.library, null as contribution_id, null as title, null::int as tier
   from lean_decl d where d.norm_hash = ${normHash} and not d.generated limit ${limit})
  union all
  (select 'ledger' as origin, u.name, u.statement, u.is_proof, u.norm, u.norm_hash,
          null as module, null as library, u.contribution_id::text, u.title, u.tier
   from lean_unit_entry u
   where u.norm_hash = ${normHash} and not u.generated and u.status = 'active' limit ${limit})`;

/** Structurally near rows, nominated by trigram overlap on the normalized
 *  statement. The threshold is deliberately low: this only decides what NCD
 *  gets to look at, and a miss here is a match the tool can never make. */
const nearCandidates = (norm: string, opts: { library?: string; module?: string; ledgerOnly?: boolean }) =>
  sql.begin(async (tx: Tx) => {
    await tx`select set_config('pg_trgm.similarity_threshold', '0.35', true)`;
    const probe = norm.slice(0, 1500);
    const library = opts.library ?? null;
    const module = opts.module ?? null;
    const libraryRows = opts.ledgerOnly
      ? []
      : await tx<DeclRow[]>`
          select 'library' as origin, d.name, d.statement, d.is_proof, d.norm, d.norm_hash,
                 d.module, d.library, null as contribution_id, null as title, null::int as tier
          from lean_decl d
          where d.norm % ${probe} and not d.generated
            and (${library}::text is null or d.library = ${library})
            and (${module}::text is null or d.module = ${module} or d.module like ${module ? `${module}.%` : null})
          order by similarity(d.norm, ${probe}) desc
          limit ${PREFILTER}`;
    const ledgerRows = await tx<DeclRow[]>`
      select 'ledger' as origin, u.name, u.statement, u.is_proof, u.norm, u.norm_hash,
             null as module, null as library, u.contribution_id::text, u.title, u.tier
      from lean_unit_entry u
      where u.norm % ${probe} and not u.generated and u.status = 'active'
      order by similarity(u.norm, ${probe}) desc
      limit ${PREFILTER}`;
    return [...libraryRows, ...ledgerRows];
  });

const asMatch = (row: DeclRow, similarity: number, exact: boolean): LeanMatch => ({
  origin: row.origin,
  name: row.name,
  statement: row.statement.replace(/\s+/g, " ").slice(0, 600),
  is_proof: row.is_proof,
  similarity,
  exact,
  ...(row.module ? { module: row.module } : {}),
  ...(row.library ? { library: row.library } : {}),
  ...(row.contribution_id ? { contribution_id: row.contribution_id } : {}),
  ...(row.title ? { title: row.title } : {}),
  ...(row.tier !== null && row.tier !== undefined ? { tier: row.tier } : {}),
});

export type SimilarArgs = {
  source?: string;
  name?: string;
  library?: string;
  module?: string;
  limit: number;
};

export type SimilarResult =
  | { error: string }
  | {
      asked: { name: string; statement: string; normalized: string };
      exact: LeanMatch[];
      near: LeanMatch[];
      searched: { library: number; ledger: number };
    };

/** One declaration, against everything Lean this ledger can see. */
export async function similarDeclarations(args: SimilarArgs): Promise<SimilarResult> {
  let name = "your declaration";
  let statement: string;

  if (args.name) {
    const [found] = await sql<{ name: string; statement: string }[]>`
      (select name, statement from lean_decl where name = ${args.name} limit 1)
      union all
      (select name, statement from lean_unit where name = ${args.name} limit 1)
      limit 1`;
    if (!found) return { error: `no declaration called ${args.name}. search_decls finds it by fragment.` };
    name = found.name;
    statement = found.statement;
  } else if (args.source?.trim()) {
    const declared = extractDecls(args.source);
    if (declared.length === 0) return { error: "no declaration in that source. Paste a theorem, lemma, def, or a statement type." };
    name = declared[0]!.name;
    // Compared as a type, the way the index holds one: binders lifted into a
    // leading ∀ and the proof dropped, so `theorem foo (s : S) : P` and the
    // stored `∀ (s : S), P` are the same question.
    statement = statementForm(declared[0]!.source);
  } else {
    return { error: "pass Lean source, or the name of a declaration already indexed." };
  }

  const { norm, norm_hash } = normalizeDecl(name, statement);
  const exactRows = await exactMatches(norm_hash, args.limit);
  const nearRows = (await nearCandidates(norm, { library: args.library, module: args.module })).filter(
    (row) => row.norm_hash !== norm_hash && row.name !== name,
  );

  const scored = await rankBySimilarity({
    mode: "lean",
    query: norm,
    normalized: true,
    candidates: nearRows.map((row, i) => ({ id: String(i), text: row.norm })),
  });
  const near = scored
    .map((s) => ({ row: nearRows[Number(s.id)]!, similarity: s.similarity }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, args.limit)
    .map(({ row, similarity }) => asMatch(row, similarity, false));

  return {
    asked: { name, statement: statement.replace(/\s+/g, " ").slice(0, 600), normalized: norm.slice(0, 600) },
    exact: exactRows.filter((row) => row.name !== name).map((row) => asMatch(row, 1, true)),
    near,
    searched: {
      library: nearRows.filter((r) => r.origin === "library").length,
      ledger: nearRows.filter((r) => r.origin === "ledger").length,
    },
  };
}

export type ScanArgs = { library?: string; module?: string; ledger?: boolean; threshold: number; limit: number };

export type ScanGroup = {
  similarity: number;
  statement: string;
  members: { name: string; module?: string; library?: string; contribution_id?: string; title?: string }[];
};

export type ScanResult = {
  scanned: number;
  identical: ScanGroup[];
  near: ScanGroup[];
  compared: number;
  note: string;
};

const SCAN_CAP = 6000;

/**
 * Everything in a namespace at once, for the caller who wants to know what is
 * duplicated rather than whether one thing is. Identical statements come from
 * the database as a group-by on the normalized hash; near-identical ones come
 * from the worker, which buckets by shingle sketch and pays NCD only inside a
 * bucket.
 */
export async function scanDuplicates(args: ScanArgs): Promise<ScanResult | { error: string }> {
  if (!args.library && !args.module && !args.ledger) {
    return { error: "say what to scan: a library, a module subtree, or ledger: true for the ledger's own Lean." };
  }
  const library = args.library ?? null;
  const module = args.module ?? null;

  const rows = args.ledger
    ? await sql<DeclRow[]>`
        select distinct on (u.norm_hash, u.name)
               'ledger' as origin, u.name, u.statement, u.is_proof, u.norm, u.norm_hash,
               null as module, null as library, u.contribution_id::text, u.title, u.tier
        from lean_unit_entry u
        where not u.generated and u.status = 'active' and u.norm is not null
        limit ${SCAN_CAP}`
    : await sql<DeclRow[]>`
        select 'library' as origin, d.name, d.statement, d.is_proof, d.norm, d.norm_hash,
               d.module, d.library, null as contribution_id, null as title, null::int as tier
        from lean_decl d
        where not d.generated and d.norm is not null
          and (${library}::text is null or d.library = ${library})
          and (${module}::text is null or d.module = ${module} or d.module like ${module ? `${module}.%` : null})
        limit ${SCAN_CAP}`;

  if (rows.length === 0) return { error: "nothing indexed under that. search_decls shows what exists." };

  const member = (row: DeclRow) => ({
    name: row.name,
    ...(row.module ? { module: row.module } : {}),
    ...(row.library ? { library: row.library } : {}),
    ...(row.contribution_id ? { contribution_id: row.contribution_id } : {}),
    ...(row.title ? { title: row.title } : {}),
  });

  const byHash = new Map<string, DeclRow[]>();
  for (const row of rows) (byHash.get(row.norm_hash) ?? byHash.set(row.norm_hash, []).get(row.norm_hash)!).push(row);
  const identical: ScanGroup[] = [...byHash.values()]
    .filter((group) => group.length > 1 && new Set(group.map((r) => r.name)).size > 1)
    .sort((a, b) => b[0]!.statement.length - a[0]!.statement.length)
    .slice(0, args.limit)
    .map((group) => ({
      similarity: 1,
      statement: group[0]!.statement.replace(/\s+/g, " ").slice(0, 400),
      members: group.map(member),
    }));

  // One representative per alpha-equivalence class into the near pass: the
  // identical ones are already reported, and leaving them in would fill every
  // bucket with pairs the caller has been told about.
  const representatives = [...byHash.values()].map((group) => group[0]!);
  const index = new Map(representatives.map((row, i) => [String(i), row]));
  const { pairs, compared } = await clusterBySimilarity({
    mode: "lean",
    normalized: true,
    units: representatives.map((row, i) => ({ id: String(i), text: row.norm })),
    threshold: args.threshold,
    limit: args.limit,
  });

  const near: ScanGroup[] = pairs.map((pair) => ({
    similarity: pair.similarity,
    statement: index.get(pair.a)!.statement.replace(/\s+/g, " ").slice(0, 400),
    members: [member(index.get(pair.a)!), member(index.get(pair.b)!)],
  }));

  return {
    scanned: rows.length,
    identical,
    near,
    compared,
    note:
      identical.length === 0 && near.length === 0
        ? "nothing above the threshold. Lower it to see weaker structural echoes."
        : "identical means the statements are the same modulo names — one of them is redundant. near means they share structure; read them before proposing anything.",
  };
}

/** Fill in what a fresh check produced, so a submission's declarations are
 *  searchable the moment the kernel has spoken. */
export async function recordUnits(checkHash: string, decls: { name: string; type: string; proof?: boolean }[]): Promise<void> {
  if (decls.length === 0) return;
  const rows = decls.map((d) => {
    const { norm, norm_hash, generated } = normalizeDecl(d.name, d.type);
    return {
      check_hash: checkHash,
      name: d.name,
      statement: d.type,
      is_proof: d.proof === true,
      norm,
      norm_hash,
      norm_v: NORM_VERSION,
      generated,
    };
  });
  await sql`insert into lean_unit ${sql(rows as never)} on conflict (check_hash, name) do update set
              statement = excluded.statement, is_proof = excluded.is_proof, norm = excluded.norm,
              norm_hash = excluded.norm_hash, norm_v = excluded.norm_v, generated = excluded.generated`;
}

/** The normalized form of arbitrary Lean, for callers who want to see what the
 *  comparison actually compares. */
export const showNormalized = (source: string): string => alphaLean(source);
