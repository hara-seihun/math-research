import { SETTLES, sql } from "./db.ts";
import { normalizeText } from "./graph.ts";

// --- References ------
// Every read door takes the same `ref`: an id, a canonical name, an imported
// handle, or a title. Requiring a uuid means a caller who just read "Cell A3
// residual" in a summary cannot ask about it without a second lookup, which is
// the kind of friction that makes a corpus feel unusable.

export type Ref = { id: string; matched: "id" | "name" | "title" | "fuzzy"; title: string; kind: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX = /^[0-9a-f]{8,32}$/i;

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
  // Agents and people naturally quote the eight-character handles shown in
  // prose and summaries. A unique UUID prefix is just as unambiguous as the
  // full id; making callers recover 28 characters adds no safety.
  if (UUID_PREFIX.test(raw)) {
    const rows = await sql<{ id: string; title: string; kind: string }[]>`
      select id, title, kind from contribution
      where replace(id::text, '-', '') like ${raw.toLowerCase() + "%"}
      order by notability desc limit 6`;
    if (rows.length === 1) return { ...rows[0]!, matched: "id" };
    if (rows.length > 1) {
      return { error: `id prefix ${raw} is ambiguous. Pass one of these full ids.`, candidates: rows.slice(0, 5) };
    }
    return { error: `no entry with id prefix ${raw}. Try search.` };
  }
  const norm = normalizeText(raw);
  // Two indexable lookups unioned, never one predicate that ORs them: an OR
  // between an expression index and a correlated EXISTS is not a plan any
  // index can serve, and Postgres answered it by scanning all 146k rows and
  // unnesting the names of each (250 ms, measured, on the hottest path in the
  // server, meaning every get, frontier, link, and every relates_to of a submit).
  const exact = await sql<{ id: string; title: string; kind: string; how: string }[]>`
    select distinct on (id) id, title, kind, how from (
      select id, title, kind, notability, 'title' as how
      from contribution
      where normalize_ref(title) = ${norm} and status = 'active' and kind <> 'edge'
        and (${kind ?? null}::text is null or kind = ${kind ?? null})
      union all
      select id, title, kind, notability, 'name' as how
      from contribution
      where names_norm @> array[${norm}] and status = 'active' and kind <> 'edge'
        and (${kind ?? null}::text is null or kind = ${kind ?? null})
    ) hit
    order by id, how, notability desc`;
  exact.sort((a, b) => (a.how === b.how ? 0 : a.how === "title" ? -1 : 1));
  exact.splice(5);
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
      select id, title, kind, max(score)::float8 as score from (
        select id, title, kind, notability, word_similarity(${raw}, title) as score
        from contribution
        where ${raw} <% title and status = 'active' and kind <> 'edge'
          and (${kind ?? null}::text is null or kind = ${kind ?? null})
        union all
        select id, title, kind, notability, word_similarity(${raw}, names_text) as score
        from contribution
        where ${raw} <% names_text and status = 'active' and kind <> 'edge'
          and (${kind ?? null}::text is null or kind = ${kind ?? null})
      ) hit
      group by id, title, kind
      order by score desc, max(notability) desc limit 5`;
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

/** A note written by a person is prose with no length limit: a promotion note
 *  runs to five thousand characters when the reviewer had that much to say. In
 *  a list it is there to tell a reader which row to open, so it is a headline
 *  too. Ten untrimmed promotion notes were 31 KB of a 96 KB `news` packet. */
export const LIST_NOTE = 240;

export const trim = (text: string | null, limit = LIST_SUMMARY): string | null => {
  if (!text) return text;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : line.slice(0, limit - 1).replace(/\s+\S*$/, "") + "…";
};

// A verifier writes for a machine: a failing axiom audit names every axiom it
// found, and a native_decide proof carries thousands. Twenty of those rows made
// the reviewer worklist a 13 MB answer to a one-row question. Every read of a
// verification carries the verdict and the head of the log; `q_verifications`
// has all of it for the one caller in a hundred who wants it.
const VERIFIER_TEXT = 600;

export const slimVerifierText = <T extends string | null | undefined>(text: T): T =>
  typeof text === "string" && text.length > VERIFIER_TEXT
    ? (`${text.slice(0, VERIFIER_TEXT)} …[truncated; q_verifications has it all]` as T)
    : text;

export const slimDetail = (detail: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === "string" ? slimVerifierText(v) : v]));

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
    ...(r.has_exposition ? { has_exposition: true } : {}),
    // Priority, printed only when it is news: ledger origin is the default and
    // saying so on every row of every list would cost more than it tells.
    ...(r.origin === "external"
      ? { origin: "external", ...(r.origin_source ? { origin_source: r.origin_source } : {}) }
      : {}),
    notability: r.notability,
    ...(r.ranking ? { ranking: r.ranking } : {}),
    ...(summary ? { summary } : {}),
  };
  if (Array.isArray(r.tags) && r.tags.length) out.topics = r.tags;
  if (Array.isArray(r.names) && r.names.length) out.names = (r.names as string[]).slice(0, 4);
  if (r.status && r.status !== "active") out.status = r.status;
  if (r.created_at) out.created_at = r.created_at;
  if (r.board_at) out.board_at = r.board_at;
  for (const extra of ["rel", "edge_tier", "joined_at", "matched", "similarity", "answers", "settled_by", "existing_links"]) {
    if (r[extra] !== undefined && r[extra] !== null) out[extra] = r[extra];
  }
  return out;
}

/** What settles a question, and what is still in the way. */
export async function settlement(id: string) {
  const answers = await sql`
    select s.id, s.kind, s.title, s.tier, s.notability, s.state, s.summary, s.origin, s.origin_source,
           e.rel, ec.tier as edge_tier, e.created_at as linked_at
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution_overview s on s.id = e.src
    where e.dst = ${id} and ec.status = 'active' and s.status = 'active'
      and e.rel = any(${SETTLES})
    order by ec.tier desc, s.notability desc limit 10`;
  return answers.map(listRow);
}
