import { sql } from "./db.ts";

// --- Expositions ------
//
// Everything else in this ledger is written for a machine to use: a statement
// an agent can transport, a dictionary row it can look its own object up in, a
// Lean file the kernel can check. None of that is a paper, and a result that
// only ever exists as a graph node is a result no person will ever read.
//
// So an exposition is its own object, not a field: a LaTeX document that
// expounds one or more entries, carried by an `expounds` edge. Being an entry
// rather than a column is what makes it work — several people may write up one
// theorem and each write-up is its own contribution with its own author and
// its own place on the review ladder, so "the canonical paper for this result"
// is a T2 edge rather than whoever wrote last. A better paper does not
// overwrite a worse one; it is submitted, linked, and reviewed.
//
// What it is not: an exposition makes no mathematical claim of its own. It
// carries the argument that is already in the ledger, in the form a person
// reads. That is why it scores low in notability and why it cannot settle a
// question — the entry it expounds does that.

export const EXPOSITION_KIND = "exposition";
export const EXPOUNDS_REL = "expounds";

export const EXPOUNDS_HELP =
  "an exposition is a paper about something already here: pass `expounds` naming the entry (or entries) it writes up, by id, name, or title. If it stands on its own instead, it is a 'result' or a 'note' — those kinds carry their own claims, and an exposition deliberately does not.";

/** Validate the exposition-specific field. Pure; ref resolution belongs to the
 *  caller, where every other ref in a submission is resolved. */
export function shapeExposition(
  kind: string,
  expounds: string | string[] | undefined,
): { refs: string[] } | { error: string } {
  const refs = (expounds === undefined ? [] : Array.isArray(expounds) ? expounds : [expounds])
    .map((r) => r.trim())
    .filter(Boolean);
  if (refs.length && kind !== EXPOSITION_KIND) {
    return { error: `expounds belongs on a submission of kind '${EXPOSITION_KIND}'.` };
  }
  if (kind === EXPOSITION_KIND && !refs.length) return { error: EXPOUNDS_HELP };
  return { refs: [...new Set(refs)].slice(0, 20) };
}

export type ExpositionRow = {
  id: string;
  title: string;
  tier: number;
  artifact_hash: string;
  media_type: string;
  author: string | null;
  created_at: Date;
};

/** The paper for each of these entries, and how many others there are. The
 *  best one is the most reviewed one, then the most strongly asserted link,
 *  then the newest — a later paper on a settled question is usually the one
 *  worth reading. */
export async function expositionsOf(
  ids: string[],
): Promise<Map<string, { best: ExpositionRow; total: number }>> {
  if (!ids.length) return new Map();
  const rows = await sql<(ExpositionRow & { entry_id: string; total: number })[]>`
    select w.id as entry_id, x.id, x.title, x.tier, x.artifact_hash, x.media_type,
           x.author, x.created_at, x.total
    from unnest(${ids}::uuid[]) as w(id)
    cross join lateral (
      select c.id, c.title, c.tier, c.artifact_hash, a.media_type, c.created_at,
             i.display_name as author, count(*) over ()::int as total
      from edge e
      join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
      join contribution c on c.id = e.src and c.status = 'active'
      join artifact a on a.hash = c.artifact_hash
      left join identity i on i.id = c.identity_id
      where e.dst = w.id and e.rel = ${EXPOUNDS_REL}
      order by c.tier desc, ec.tier desc, c.created_at desc, c.id
      limit 1
    ) x`;
  return new Map(
    rows.map(({ entry_id, total, ...best }) => [entry_id, { best, total }]),
  );
}

/** Mark the rows of a list page that have a paper behind them, so a reader
 *  scanning results can tell without opening each one. One query per page. */
export async function annotateExpositions(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows;
  const found = await sql<{ id: string }[]>`
    select distinct e.dst as id
    from edge e
    join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
    join contribution c on c.id = e.src and c.status = 'active'
    where e.rel = ${EXPOUNDS_REL} and e.dst = any(${rows.map((r) => r.id as string)}::uuid[])`;
  const has = new Set(found.map((r) => r.id));
  return rows.map((row) => (has.has(row.id as string) ? { ...row, has_exposition: true } : row));
}
