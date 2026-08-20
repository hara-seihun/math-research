import { sql } from "./db.ts";
import { normalizeText } from "./graph.ts";

// --- References ------
// Every read door takes the same `ref`: an id, a canonical name, an imported
// handle, or a title. Requiring a uuid means a caller who just read "Cell A3
// residual" in a summary cannot ask about it without a second lookup, which is
// the kind of friction that makes a corpus feel unusable.

export type Ref = { id: string; matched: "id" | "name" | "title" | "fuzzy"; title: string; kind: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `kind` hard-filters; `prefer` only breaks a tie, so "cell A3" asked of
 *  frontier lands on the question rather than the write-up about it. */
export async function deref(
  ref: string,
  opts?: string | { kind?: string; prefer?: string[] },
): Promise<Ref | { error: string; candidates?: unknown[] }> {
  const { kind, prefer } = typeof opts === "string" ? { kind: opts, prefer: undefined } : (opts ?? {});
  const raw = ref.trim();
  if (!raw) return { error: "pass an id, name, handle, or title." };
  if (UUID.test(raw)) {
    const [row] = await sql<{ id: string; title: string; kind: string }[]>`
      select id, title, kind from contribution where id = ${raw}`;
    return row ? { ...row, matched: "id" } : { error: `no entry with id ${raw}. Try search.` };
  }
  const norm = normalizeText(raw);
  const exact = await sql<{ id: string; title: string; kind: string; how: string }[]>`
    select id, title, kind,
           case when normalize_ref(title) = ${norm} then 'title' else 'name' end as how
    from contribution
    where status = 'active' and kind <> 'edge'
      and (normalize_ref(title) = ${norm} or exists (select 1 from unnest(names) n where normalize_ref(n) = ${norm}))
      and (${kind ?? null}::text is null or kind = ${kind ?? null})
    order by (kind = coalesce(${kind ?? null}, kind)) desc, notability desc limit 5`;
  // A ref that is some entry's own title beats an entry that merely lists it as
  // an alias: the caller typed the thing as it is displayed.
  const titled = exact.filter((r) => r.how === "title");
  const preferred = prefer ? exact.filter((r) => prefer.includes(r.kind)) : [];
  const winner =
    exact.length === 1 ? exact[0] : titled.length === 1 ? titled[0] : preferred.length === 1 ? preferred[0] : undefined;
  if (winner) return { id: winner.id, title: winner.title, kind: winner.kind, matched: winner.how as "name" | "title" };
  if (exact.length > 1) {
    return { error: `"${raw}" names ${exact.length} entries. Pass one of these, by id or exact title.`, candidates: exact };
  }
  const fuzzy = await sql.begin(async (tx) => {
    await tx`select set_config('pg_trgm.word_similarity_threshold', '0.35', true)`;
    return tx<{ id: string; title: string; kind: string; score: number }[]>`
      select id, title, kind,
             greatest(word_similarity(${raw}, title),
                      coalesce((select max(similarity(${raw}, n)) from unnest(names) n), 0)) as score
      from contribution
      where status = 'active' and kind <> 'edge'
        and (${raw} <% title or exists (select 1 from unnest(names) n where n % ${raw}))
        and (${kind ?? null}::text is null or kind = ${kind ?? null})
      order by score desc, notability desc limit 5`;
  });
  if (!fuzzy.length) return { error: `nothing here is called "${raw}". Try search.` };
  // A tie the door itself can break: "cell N4 residual" asked of frontier is
  // the question, not the write-up attacking it.
  const top = fuzzy[0]!;
  const tied = fuzzy.filter((r) => r.score > top.score - 0.05);
  const preferredTied = prefer ? tied.filter((r) => prefer.includes(r.kind)) : [];
  const best = tied.length === 1 ? top : preferredTied.length === 1 ? preferredTied[0]! : undefined;
  if (!best) {
    return { error: `"${raw}" is ambiguous. Pass one of these, by id or exact title.`, candidates: fuzzy };
  }
  return { id: best.id, title: best.title, kind: best.kind, matched: "fuzzy" };
}

// --- Response shaping ------
// List doors return many rows, and an imported statement's summary is up to
// 2000 characters. Twenty of those is a 40 KB wall that buries the structure a
// reader is scanning for, so list rows carry a headline-length summary and the
// full text lives one `get` away.

export const LIST_SUMMARY = 160;

export const trim = (text: string | null, limit = LIST_SUMMARY): string | null => {
  if (!text) return text;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : line.slice(0, limit - 1).replace(/\s+\S*$/, "") + "…";
};

/** Two strings that say the same thing, whitespace aside. */
export const sameText = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** A title cut from the opening of its own summary, which is most of an
 *  imported corpus, makes the summary a verbatim echo. Show what the title
 *  does not already say, and nothing when that is nothing. */
export function beyondTitle(title: string, summary: string | null, limit = LIST_SUMMARY): string | null {
  if (!summary) return null;
  const line = summary.replace(/\s+/g, " ").trim();
  const head = title.replace(/\s+/g, " ").trim().replace(/…$/, "");
  if (!line.startsWith(head)) return trim(line, limit);
  const rest = line.slice(head.length).replace(/^[\s.:;,—–-]+/, "");
  return rest ? trim(rest, limit) : null;
}

/** One list row: the identifying facts, nothing that needs paging. */
export function listRow(r: Record<string, unknown>) {
  const summary = beyondTitle(r.title as string, r.summary as string | null);
  const out: Record<string, unknown> = {
    id: r.id,
    kind: r.kind,
    title: r.title,
    ...(r.state ? { state: r.state } : {}),
    tier: r.tier,
    ...(r.lean_verified ? { lean_verified: true } : {}),
    notability: r.notability,
    ...(summary ? { summary } : {}),
  };
  if (Array.isArray(r.tags) && r.tags.length) out.topics = r.tags;
  if (Array.isArray(r.names) && r.names.length) out.names = (r.names as string[]).slice(0, 4);
  if (r.status && r.status !== "active") out.status = r.status;
  if (r.created_at) out.created_at = r.created_at;
  for (const extra of ["rel", "edge_tier", "linked_at", "joined_at", "matched", "similarity", "answers", "existing_links"]) {
    if (r[extra] !== undefined && r[extra] !== null) out[extra] = r[extra];
  }
  return out;
}

/** What settles a question, and what is still in the way. */
export async function settlement(id: string) {
  const answers = await sql`
    select s.id, s.kind, s.title, s.tier, s.notability, s.state, s.summary, e.rel, ec.tier as edge_tier,
           e.created_at as linked_at
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution_overview s on s.id = e.src
    where e.dst = ${id} and ec.status = 'active' and s.status = 'active'
      and e.rel in ('answers', 'proves', 'disproves', 'refutes', 'resolves')
    order by ec.tier desc, s.notability desc limit 10`;
  return answers.map(listRow);
}
