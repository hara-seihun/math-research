import { sql } from "./db.ts";
import { listRow, trim } from "./read.ts";

// --- The theory family ------
// A write-up is not a theory. What makes Galois theory usable by someone who
// did not invent it is not the exposition: it is that the exposition comes
// with a class of situations it applies to, a vocabulary anything else can
// point at, and a *dictionary* — intermediate fields to subgroups, normality
// to normality, degree to index — under which a question on one side is the
// same question on the other. Record those three and a later agent can
// transport a problem through the theory without reading a word of prose.
//
// So the family is four kinds and one derived consequence:
//
//   theory          the framework: what it applies to, what it introduces,
//                   what it rests on
//   definition      one concept the theory introduces, nameable and pointable
//                   at from anywhere (submitting a theory mints these)
//   correspondence  one dictionary belonging to a theory: two sides and the
//                   rows that translate between them, each row optionally
//                   naming the entry that proves it
//   reformulation   one entry restated through a theory, with the fidelity of
//                   the restatement: equivalent, one-directional, or heuristic
//
// The consequence lives in the database (settlement_transport in schema.sql):
// a question with a reviewed, equivalent reformulation is settled when the
// reformulation is answered. That is the whole payoff of a theory, and it is
// why fidelity is a typed field with a review gate rather than an adjective.

export const FAMILY_KINDS = ["theory", "correspondence", "reformulation"] as const;

export const CORRESPONDENCE_FIDELITY = ["equivalence", "one-way", "lossy"] as const;
export const REFORMULATION_FIDELITY = ["equivalent", "implies", "implied-by", "heuristic"] as const;

export type DictionaryRow = { source: string; target: string; note?: string; proof?: string };

export type FamilyInput = {
  applies_to?: string;
  transports_to?: string;
  dictionary?: DictionaryRow[];
  fidelity?: string;
  introduces?: { term: string; statement: string; names?: string[] }[];
  reformulates?: string;
  via?: string;
};

/** A link this submission owes, before its ref is resolved. `row` marks a
 *  dictionary row whose proof reference is rewritten to an id once it is. */
export type PendingLink = { ref: string; rel: string; note?: string; row?: number };

export type FamilyShape = {
  metadata: Record<string, unknown>;
  links: PendingLink[];
  definitions: { term: string; statement: string; names: string[] }[];
};

const OWNED_BY: Record<keyof FamilyInput, string[]> = {
  applies_to: ["theory", "correspondence"],
  transports_to: ["correspondence"],
  dictionary: ["correspondence"],
  fidelity: ["correspondence", "reformulation"],
  introduces: ["theory"],
  reformulates: ["reformulation"],
  via: ["reformulation", "correspondence"],
};

const nonEmpty = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Validate the kind-specific fields and turn them into metadata, the links
 *  the entry owes, and the definitions it mints. Pure: ref resolution belongs
 *  to the caller, which is where every other ref in a submission is resolved. */
export function shapeFamily(kind: string, input: FamilyInput): FamilyShape | { error: string } {
  for (const [field, kinds] of Object.entries(OWNED_BY) as [keyof FamilyInput, string[]][]) {
    if (input[field] !== undefined && !kinds.includes(kind)) {
      return { error: `${field} belongs on a submission of kind ${kinds.map((k) => `'${k}'`).join(" or ")}.` };
    }
  }

  const metadata: Record<string, unknown> = {};
  const links: PendingLink[] = [];
  const definitions: FamilyShape["definitions"] = [];
  const appliesTo = nonEmpty(input.applies_to);
  const transportsTo = nonEmpty(input.transports_to);
  const fidelity = nonEmpty(input.fidelity);
  const via = nonEmpty(input.via);

  if (kind === "theory") {
    if (!appliesTo) {
      return {
        error:
          "a theory needs applies_to: the class of objects or hypotheses it covers, precisely enough that someone holding one can tell whether it applies (e.g. 'finite separable field extensions'). Without it the entry is an exposition, which is a fine kind to use.",
      };
    }
    metadata.applies_to = appliesTo;
    for (const [i, d] of (input.introduces ?? []).entries()) {
      const term = nonEmpty(d.term);
      const statement = nonEmpty(d.statement);
      if (!term || !statement) return { error: `introduces[${i}] needs both a term and its statement.` };
      definitions.push({
        term,
        statement,
        names: [term, ...(d.names ?? []).map((n) => n.trim()).filter(Boolean)].slice(0, 12),
      });
    }
  }

  if (kind === "correspondence") {
    if (!appliesTo || !transportsTo) {
      return {
        error:
          "a correspondence needs both sides: applies_to names what it translates from, transports_to what it translates into (e.g. 'finite separable field extensions' and 'finite groups').",
      };
    }
    const rows = input.dictionary ?? [];
    if (!rows.length) {
      return {
        error:
          "a correspondence needs a dictionary: at least one row translating something on the source side into something on the target side. Rows are what other agents transport their objects through, so prose alone does not count.",
      };
    }
    if (!fidelity || !(CORRESPONDENCE_FIDELITY as readonly string[]).includes(fidelity)) {
      return {
        error: `a correspondence needs fidelity: ${CORRESPONDENCE_FIDELITY.join(", ")}. 'equivalence' means the dictionary is a bijection and questions transport both ways; 'one-way' means truth transports in one direction only; 'lossy' means it is a guide, not a theorem.`,
      };
    }
    const dictionary: DictionaryRow[] = [];
    for (const [i, r] of rows.entries()) {
      const source = nonEmpty(r.source);
      const target = nonEmpty(r.target);
      if (!source || !target) return { error: `dictionary[${i}] needs both source and target.` };
      const proof = nonEmpty(r.proof);
      if (proof) links.push({ ref: proof, rel: "rests-on", note: `proves the dictionary row "${source}" ↔ "${target}"`, row: i });
      dictionary.push({ source, target, ...(r.note?.trim() ? { note: r.note.trim() } : {}), ...(proof ? { proof } : {}) });
    }
    metadata.applies_to = appliesTo;
    metadata.transports_to = transportsTo;
    metadata.fidelity = fidelity;
    metadata.dictionary = dictionary;
    if (via) links.push({ ref: via, rel: "dictionary-of", note: "a dictionary of this theory" });
  }

  if (kind === "reformulation") {
    const reformulates = nonEmpty(input.reformulates);
    if (!reformulates || !via) {
      return {
        error:
          "a reformulation needs reformulates (the entry you are restating) and via (the theory or correspondence you restated it through). Both take an id, name, or title.",
      };
    }
    if (!fidelity || !(REFORMULATION_FIDELITY as readonly string[]).includes(fidelity)) {
      return {
        error: `a reformulation needs fidelity: ${REFORMULATION_FIDELITY.join(", ")}. Only 'equivalent' transports settlement, and only once both this entry and its reformulates link are reviewed to T2, so claim it when you can defend the equivalence in both directions.`,
      };
    }
    metadata.fidelity = fidelity;
    links.push({ ref: reformulates, rel: "reformulates", note: `restated through the theory, fidelity: ${fidelity}` });
    links.push({ ref: via, rel: "via" });
  }

  return { metadata, links, definitions };
}

// --- Reading ------

const TRANSPORT_COLUMNS = sql`
  t.reformulation_id, t.title, t.tier, t.notability, t.fidelity, t.transports as transports_settlement,
  t.reformulates_id, t.reformulates, t.reformulates_kind, t.reformulates_state,
  t.via_id, t.via, t.via_kind, t.created_at`;

export async function theoryList(limit: number, offset: number) {
  return sql`
    select c.id, c.kind, c.title, c.summary, c.tier, c.notability, c.names, c.state,
           c.origin, c.origin_source, c.lean_verified, c.created_at,
           c.metadata->>'applies_to' as applies_to,
           s.dictionaries, s.vocabulary, s.transports, s.questions_settled
    from contribution_overview c
    cross join lateral (
      select (select count(*)::int from edge e join contribution ec on ec.id = e.contribution_id
               where e.dst = c.id and e.rel = 'dictionary-of' and ec.status = 'active') as dictionaries,
             (select count(*)::int from edge e join contribution ec on ec.id = e.contribution_id
               join contribution d on d.id = e.dst and d.status = 'active'
               where e.src = c.id and e.rel = 'introduces' and ec.status = 'active') as vocabulary,
             (select count(*)::int from q_transports t where t.theory_id = c.id) as transports,
             (select count(distinct t.reformulates_id)::int from q_transports t
               where t.theory_id = c.id and t.reformulates_state = 'settled') as questions_settled
    ) s
    where c.kind = 'theory' and c.status = 'active'
    order by s.transports desc, c.notability desc, c.created_at desc
    limit ${limit} offset ${offset}`;
}

export async function theoryDetail(id: string) {
  const [theory] = await sql`
    select c.id, c.kind, c.title, c.summary, c.tier, c.notability, c.names, c.tags, c.metadata,
           c.origin, c.origin_source, c.lean_verified, c.created_at, c.updated_at,
           i.display_name as author
    from contribution_overview c left join identity i on i.id = c.identity_id
    where c.id = ${id}`;
  const vocabulary = await sql`
    select d.id, d.kind, d.title, d.tier, d.notability, d.names, d.created_at, left(a.content, 600) as statement
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution_overview d on d.id = e.dst
    join artifact a on a.hash = d.artifact_hash
    where e.src = ${id} and e.rel = 'introduces' and ec.status = 'active' and d.status = 'active'
    order by d.notability desc, d.created_at`;
  const dictionaries = await sql`
    select c.id, c.title, c.tier, c.notability,
           c.metadata->>'applies_to' as source_side,
           c.metadata->>'transports_to' as target_side,
           c.metadata->>'fidelity' as fidelity,
           c.metadata->'dictionary' as rows
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution c on c.id = e.src
    where e.dst = ${id} and e.rel = 'dictionary-of' and ec.status = 'active'
      and c.status = 'active' and c.kind = 'correspondence'
    order by c.notability desc, c.created_at`;
  const rests = await sql`
    select p.id, p.kind, p.title, p.summary, p.tier, p.state, p.notability, p.lean_verified,
           p.origin, p.origin_source, p.names, p.created_at, e.rel
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution_overview p on p.id = e.dst
    where e.src = ${id} and e.rel in ('rests-on', 'depends-on', 'uses') and ec.status = 'active'
      and p.status = 'active'
    order by p.notability desc limit 20`;
  const transports = await sql`
    select ${TRANSPORT_COLUMNS} from q_transports t
    where t.theory_id = ${id}
    order by (t.reformulates_state = 'settled') desc, t.notability desc, t.created_at desc limit 50`;
  const applications = await sql`
    select s.id, s.kind, s.title, s.summary, s.tier, s.state, s.notability, s.lean_verified,
           s.origin, s.origin_source, s.names, s.created_at, e.rel
    from edge e join contribution ec on ec.id = e.contribution_id
    join contribution_overview s on s.id = e.src
    where e.dst = ${id} and ec.status = 'active' and s.status = 'active'
      and s.kind <> 'reformulation' and s.kind <> 'correspondence'
      and e.rel in ('uses', 'via', 'depends-on', 'generalizes', 'specializes', 'proves')
    order by s.notability desc limit 25`;
  return { theory, vocabulary, dictionaries, rests, transports, applications };
}

/** What a theory has been asked to do for one entry, and what might. The
 *  first half is graph fact; the second is a suggestion and says so. */
export async function theoriesFor(id: string) {
  const [entry] = await sql<{ title: string; summary: string; kind: string; has_embedding: boolean }[]>`
    select title, summary, kind, embedding is not null as has_embedding from contribution where id = ${id}`;
  if (!entry) return { error: "no entry with that id" };

  const transported = await sql`
    select ${TRANSPORT_COLUMNS} from q_transports t
    where t.reformulates_id = ${id}
    order by t.notability desc, t.created_at desc limit 20`;

  // Candidates: the theory whose own text is nearest this entry's, which is
  // what the corpus already measures for everything else (see related). No
  // embedding yet — a brand new entry, or an instance whose embedder is
  // warming — degrades to the text index rather than returning nothing.
  const candidates = entry.has_embedding
    ? await sql`
        select c.id, c.title, c.tier, c.notability, c.metadata->>'applies_to' as applies_to,
               round((1 - (c.embedding <=> (select embedding from contribution where id = ${id})))::numeric, 4)::float8 as similarity
        from contribution c
        where c.kind = 'theory' and c.status = 'active' and c.embedding is not null and c.id <> ${id}
        order by c.embedding <=> (select embedding from contribution where id = ${id})
        limit 6`
    : await sql`
        select c.id, c.title, c.tier, c.notability, c.metadata->>'applies_to' as applies_to,
               round(ts_rank(c.search, plainto_tsquery('english', ${`${entry.title} ${entry.summary}`}))::numeric, 4)::float8 as similarity
        from contribution c
        where c.kind = 'theory' and c.status = 'active' and c.id <> ${id}
          and c.search @@ plainto_tsquery('english', ${`${entry.title} ${entry.summary}`})
        order by similarity desc limit 6`;

  // The sharper signal when it fires: a dictionary row whose source side
  // reads like the thing this entry is about. Trigram word similarity over a
  // few hundred short strings is microseconds, and a hit names the exact row
  // to transport through.
  const rows = await sql.begin(async (tx) => {
    await tx`select set_config('pg_trgm.word_similarity_threshold', '0.4', true)`;
    return tx`
      select d.correspondence_id, d.correspondence, d.theory_id, d.source, d.target, d.note,
             round(word_similarity(d.source, ${`${entry.title} ${entry.summary}`})::numeric, 4)::float8 as match
      from q_dictionary d
      where d.source <% ${`${entry.title} ${entry.summary}`}
      order by match desc limit 8`;
  });

  return { entry, transported, candidates, dictionary_hits: rows };
}

/** For a settled question, the reviewed equivalences that carried the answer
 *  in from somewhere else, and what answered it there. Empty for the ordinary
 *  case where something answers the question directly. */
export async function transportedSettlement(id: string) {
  const chains = await sql`
    select r.node, r.depth, n.kind, n.title, n.tier,
           s.id as answered_by_id, s.kind as answered_by_kind, s.title as answered_by, s.tier as answered_by_tier,
           e.rel
    from transport_closure(array[${id}]::uuid[]) r
    join contribution n on n.id = r.node
    join edge e on e.dst = r.node
    join contribution ec on ec.id = e.contribution_id and ec.status = 'active'
    join contribution s on s.id = e.src and s.status = 'active'
    where r.depth > 0 and e.rel in ('answers', 'proves', 'disproves', 'refutes', 'resolves')
    order by r.depth, s.notability desc limit 10`;
  return chains.map((c) => ({
    through: { id: c.node, kind: c.kind, title: c.title, tier: c.tier, hops: c.depth },
    answered_by: { id: c.answered_by_id, kind: c.answered_by_kind, title: c.answered_by, tier: c.answered_by_tier, rel: c.rel },
  }));
}

/** Reformulations of one entry, whichever way they point: what it has been
 *  restated as, and what has been restated as it. */
export async function reformulationsOf(id: string) {
  const out = await sql`
    select ${TRANSPORT_COLUMNS} from q_transports t
    where t.reformulates_id = ${id} order by t.notability desc limit 10`;
  return out.map((t: Record<string, unknown>) => ({
    id: t.reformulation_id,
    title: t.title,
    tier: t.tier,
    fidelity: t.fidelity,
    transports_settlement: t.transports_settlement,
    via: { id: t.via_id, title: t.via, kind: t.via_kind },
  }));
}

export const dictionaryRows = (raw: unknown, cap = 40): DictionaryRow[] =>
  Array.isArray(raw) ? (raw.slice(0, cap) as DictionaryRow[]) : [];

export const definitionRow = (r: Record<string, unknown>) => ({
  ...listRow(r),
  statement: trim(r.statement as string, 400),
});
