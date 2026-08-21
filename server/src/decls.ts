/**
 * What the libraries already provide, as data.
 *
 * Every declaration in the pinned toolchain, Mathlib, and MathlibPlus is
 * indexed in `lean_decl` (tools/index-decls.sh writes it; lean/DumpDecls.lean
 * extracts it from the built oleans). Before this existed the only way to ask
 * "is there already a lemma for this?" was a twenty-second `check_lean` round
 * trip running `exact?` or an environment scan, which also cannot see a
 * MathlibPlus module you have not already guessed the name of. This answers
 * from Postgres in a millisecond, and it is the same set of declarations
 * `check_lean` can import.
 */
import { sql } from "./db.ts";

export type DeclRow = {
  name: string;
  module: string;
  library: string;
  kind: string;
  statement: string;
  is_proof: boolean;
};

/** ILIKE metacharacters in a term are the caller's literal text, not a pattern
 *  language they did not ask for: `Finset.card_le_card` must not match on `_`. */
const like = (term: string) => `%${term.replace(/([\\%_])/g, "\\$1")}%`;

/** Quoted phrases stay whole; everything else splits on whitespace. */
export function terms(query: string): string[] {
  const found = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").trim());
  return [...new Set(found.filter(Boolean))].slice(0, 8);
}

export type DeclSearch = {
  query: string;
  library?: string;
  module?: string;
  names_only: boolean;
  proofs_only: boolean;
  limit: number;
  offset: number;
};

const COUNT_CAP = 2000;

export async function searchDecls(params: DeclSearch): Promise<{ rows: DeclRow[]; total: number; capped: boolean }> {
  const words = terms(params.query);
  if (words.length === 0) return { rows: [], total: 0, capped: false };

  const matches = words
    .map((t) =>
      params.names_only
        ? sql`d.name ilike ${like(t)}`
        : sql`(d.name ilike ${like(t)} or d.statement ilike ${like(t)})`,
    )
    .reduce((acc, frag) => sql`${acc} and ${frag}`);

  const where = sql`
    ${matches}
    and (${params.library ?? null}::text is null or d.library = ${params.library ?? null})
    and (${params.module ?? null}::text is null or d.module = ${params.module ?? null}
         or d.module like ${params.module ? `${params.module}.%` : null})
    and (not ${params.proofs_only} or d.is_proof)`;

  // A whole-corpus count for a two-letter term is a scan nobody asked for, so
  // the count stops at COUNT_CAP and says it stopped.
  const [rows, [counted]] = await Promise.all([
    sql<DeclRow[]>`
      select d.name, d.module, d.library, d.kind, d.statement, d.is_proof
      from lean_decl d
      where ${where}
      order by
        (case when lower(d.name) = lower(${params.query}) then 400 else 0 end)
        + (case when lower(regexp_replace(d.name, '^.*\\.', '')) = lower(${params.query}) then 200 else 0 end)
        + (case when d.name ilike ${like(params.query)} then 100 else 0 end)
        + (case d.library when 'Mathlib' then 30 when 'Batteries' then 20 when 'Init' then 20
                          when 'Std' then 20 when 'MathlibPlus' then 10 else 0 end)
        + (case when d.is_proof then 5 else 0 end)
        desc,
        length(d.name), d.name
      limit ${params.limit} offset ${params.offset}`,
    sql<{ n: number }[]>`
      select count(*)::int as n from (
        select 1 from lean_decl d where ${where} limit ${COUNT_CAP}) capped`,
  ]);
  const total = counted?.n ?? 0;
  return { rows, total, capped: total >= COUNT_CAP };
}

export type IndexSummary = {
  library: string;
  declarations: number;
  proofs: number;
  modules: number;
  indexed_at: Date;
}[];

/** What is actually in the index, which is also the honest answer to
 *  "what can I import here?". */
export const indexSummary = (): Promise<IndexSummary> => sql<IndexSummary>`
  select library, count(*)::int as declarations,
         count(*) filter (where is_proof)::int as proofs,
         count(distinct module)::int as modules,
         max(indexed_at) as indexed_at
  from lean_decl group by library order by declarations desc`;
