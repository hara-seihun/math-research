import { z } from "zod";

// One source of truth for what every tool returns. Each schema below is
// registered as the tool's outputSchema (advertised in tools/list) and the SDK
// validates every structuredContent against it at call time, so the shapes here
// cannot drift from the responses without failing the call. The contract suite
// calls every tool, which makes drift a test failure rather than a surprise.
//
// Strict objects on purpose: an undeclared field in a response is a schema bug,
// and it should fail loudly here rather than ship an undocumented surface.

const iso = z.string().describe("ISO 8601 timestamp");
const jsonRecord = z.record(z.string(), z.unknown());

/** How far review has got with a claim. Null for exactly one kind: a review
 *  is the judgement, so there is no ladder underneath it, and it is the null
 *  here that keeps reviews out of their own worklist (see schema.sql). An
 *  edge's own tier is a different field and is never null -- an edge is an
 *  assertion, and asserting one can be reviewed. */
const tier = z
  .number().int().nullable()
  .describe("Review tier: 0 recorded, 1 confirmed, 2 canon, 3 published. Null for a review, which is a judgement rather than a claim awaiting one.");

/** Success and failure results. A failure is isError with the same teaching
 *  JSON in the text block.
 *
 *  The schemas here are deliberately NOT all advertised in tools/list:
 *  advertising all of them cost every connecting client ~16k tokens at session
 *  start (measured), so only the small write/admin schemas are advertised and
 *  the read tools describe their shape in prose. That advertisement is also
 *  what decides the wire shape. A tool that declares an outputSchema owes its
 *  caller `structuredContent`, and a text twin for clients that predate it. A
 *  tool that declares none owes a text block and nothing else, so sending the
 *  same payload twice bought nobody anything: it was 50% of every read
 *  response, 70 KB of the 141 KB a single `news` used to weigh.
 *
 *  The text block is compact JSON, not pretty-printed: the indentation alone
 *  cost 9-34% of every response (measured), and both agents and jq read
 *  compact JSON fine.
 *
 *  Validation is the contract suite's job, not every caller's. Walking a 70 KB
 *  response through a strict zod schema on the way out is real CPU on a
 *  single-threaded runtime, and the suite already calls every tool. Set
 *  MCP_VALIDATE=1 (contracts.sh does) to make drift throw. */
const VALIDATE = process.env.MCP_VALIDATE === "1";

const jsonText = (text: string) => ({ type: "text" as const, text });

/** The schemas the tool surface actually advertises, registered at startup
 *  from the tools themselves so this list cannot drift from what tools/list
 *  says. A schema in here is a promise of `structuredContent`; one that isn't
 *  describes a text block, and sending both would be paying twice to keep a
 *  promise nobody was made. */
const advertised = new WeakSet<z.ZodType>();
export const markAdvertised = (schemas: z.ZodType[]) => schemas.forEach((s) => advertised.add(s));

export const structured = (schema: z.ZodType, value: unknown) => {
  // One serialization, reused as the wire text. Dates become ISO strings and
  // undefined-valued keys drop out, which is exactly the shape to validate.
  const text = JSON.stringify(value);
  const owed = advertised.has(schema);
  if (!VALIDATE && !owed) return { content: [jsonText(text)] };
  const wire = JSON.parse(text) as Record<string, unknown>;
  if (VALIDATE) schema.parse(wire);
  return owed ? { content: [jsonText(text)], structuredContent: wire } : { content: [jsonText(text)] };
};

export const fail = (value: unknown) => ({ content: [jsonText(JSON.stringify(value))], isError: true as const });

/** A shortened list row: what search, browse, and every neighbourhood list
 *  return. Full text lives one `get` away. */
export const ListRow = z
  .strictObject({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    state: z.string().optional().describe("Derived work state (open/settled/retired); only work items carry one."),
    tier,
    lean_verified: z.literal(true).optional(),
    has_exposition: z.literal(true).optional().describe("Someone has written this up as a paper; get(<ref>) names it."),
    origin: z.literal("external").optional().describe("Present only when the headline claim was established outside this ledger; ledger origin is the default and is not printed."),
    origin_source: z.string().optional().describe("What established an external-origin entry."),
    notability: z.number(),
    ranking: z
      .strictObject({
        built_on_by: z.number().int().describe("Distinct active entries linking to this one."),
        settles: z.number().int().describe("Distinct active questions this entry answers, proves, disproves, refutes, or resolves."),
        reviewed_impact: z
          .strictObject({
            reach: z.number(),
            advance: z.number(),
            closure: z.number(),
            total: z.number(),
            assessments: z.number().int(),
            score: z.number(),
          })
          .optional()
          .describe("Mean T2 reviewed impact dimensions and the resulting all-time score."),
      })
      .optional()
      .describe("Transparent graph signals behind notability-ranked browse results."),
    summary: z.string().optional().describe("Shortened; get(<ref>) has the full text."),
    topics: z.array(z.string()).optional(),
    names: z.array(z.string()).optional(),
    status: z.string().optional().describe("Present only when not 'active' (retracted/superseded)."),
    created_at: iso.optional(),
    board_at: iso.optional().describe("When this entry reached the all-time board, meaning when review certified it. Present only for rows on it, and what `since` windows when `board: true`."),
    rel: z.string().optional().describe("The relation this row arrived through, when listed via a link."),
    edge_tier: z.number().int().optional().describe("The linking edge's own review tier."),
    link: z
      .strictObject({
        rel: z.string(),
        src: z.strictObject({ id: z.string(), kind: z.string(), title: z.string(), tier, status: z.string() }),
        dst: z.strictObject({ id: z.string(), kind: z.string(), title: z.string(), tier, status: z.string() }),
      })
      .optional()
      .describe("What an edge row actually asserts, both endpoints named. A link's title is only its relation, so without this a reviewer cannot tell 'uses' from 'uses' and has to fetch every row to judge it."),
    joined_at: iso.optional().describe("When this member joined the front."),
    matched: z.string().optional().describe("How search matched it: 'every term', 'some terms', or 'fuzzy'."),
    similarity: z.number().optional(),
    answers: z.number().int().optional().describe("How many active entries answer/prove/refute this."),
    settled_by: z
      .array(z.strictObject({
        id: z.string(), kind: z.string(), title: z.string(), tier,
        origin: z.literal("external").optional(),
        origin_source: z.string().optional(),
      }))
      .optional()
      .describe("For a settled question on a browse page: the active entries that answer/prove/disprove/refute/resolve it, most notable first (up to 3)."),
    existing_links: z
      .array(z.strictObject({ rel: z.string(), edge_tier: z.number().int() }))
      .optional()
      .describe("Links that already exist between this row and the query entry, so you don't duplicate them."),
  })
  .describe("One entry, shortened for lists.");

const offsetCursor = z
  .strictObject({ offset: z.number().int() })
  .nullable()
  .describe("Pass this offset to page on; null means the listing is complete.");

export const ExploringNow = z
  .strictObject({
    trail_id: z.string(),
    title: z.string(),
    by: z.string().nullable(),
    latest_note: z.string().nullable(),
    last_activity: iso,
  })
  .describe("A fresh open trail touching this entry: someone is exploring here now.");

const NeighbourLink = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  tier,
  edge_tier: z.number().int(),
  status: z.string().optional().describe("Only when not 'active'."),
});
export const Neighbourhood = z
  .strictObject({
    out: z.record(z.string(), z.array(NeighbourLink)).describe("Outgoing links, grouped by relation, top rows by (edge tier, notability)."),
    in: z.record(z.string(), z.array(NeighbourLink)).describe("Incoming links, grouped by relation, same order."),
    more: z
      .strictObject({
        out: z.record(z.string(), z.number().int()).optional(),
        in: z.record(z.string(), z.number().int()).optional(),
      })
      .optional()
      .describe("How many rows per relation are not shown. Page one relation with get's rel/links_offset, or use query."),
  })
  .describe("The typed neighbourhood, capped per relation, each link carrying its own review tier. q_links has assertion times and asserting identities.");

const Receipt = z
  .strictObject({ payload: jsonRecord, server_signature: z.string() })
  .describe("Server-signed Ed25519 receipt binding artifact, identity, and time.");

const KindCount = z.strictObject({
  kind: z.string(),
  n: z.number().int(),
  states: z.record(z.string(), z.number().int()).optional().describe("Work-state breakdown, when the kind has one."),
  means: z.string().optional().describe("What this kind is here."),
});

/** How much is here: entries, and the links between them, counted apart. */
export const CorpusTotals = z.strictObject({
  entries: z.number().int(),
  links: z.number().int(),
  programmes: z.number().int(),
  open_questions: z.number().int(),
  lean_verified: z.number().int(),
  active_trails: z.number().int(),
});

export const HelloOut = z.strictObject({
  welcome: z.string(),
  you: z.strictObject({
    identity: z.string().nullable(),
    via: z.string(),
    contributor_key: z.string().optional().describe("Shown once when this call minted your identity. Save it."),
    what_that_means: z.string(),
    how_identity_works: z.string(),
  }),
  what_is_here: z.strictObject({
    note: z.string(),
    totals: CorpusTotals,
    kinds: z.array(KindCount),
    by_tier: z.array(z.strictObject({ tier: z.number().int(), n: z.number().int() })).describe("The review ladder over entries; links climb the same ladder and are counted in totals.links."),
    top_topics: z.array(z.strictObject({ topic: z.string(), n: z.number().int() })),
  }),
  research_programmes: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      members: z.number().int(),
      open_problems: z.number().int(),
    }),
  ),
  established_here: z.array(ListRow),
  most_notable: z.array(ListRow),
  fresh_canon: z.array(ListRow),
  how_to_ask: z.record(z.string(), z.string()),
  tips: z.array(z.string()),
  server_public_key: z.string(),
});

export const SearchOut = z.strictObject({
  query: z.string().optional().describe("Echoed when this was a text search."),
  results: z.array(ListRow),
  matched: z
    .strictObject({
      every_term: z.number().int().describe("How many results matched every term."),
      weaker: z.number().int().describe("How many are partial or fuzzy matches."),
    })
    .optional()
    .describe("Present for text searches."),
  total: z.number().int().optional().describe("Present for filter-only listings: how many entries match beyond this page."),
  next: offsetCursor,
  tip: z.string(),
});




export const FrontsOut = z
  .strictObject({
    fronts: z
      .array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          summary: z.string().optional(),
          members: z.number().int(),
          problems: z.strictObject({ open: z.number().int(), settled: z.number().int() }),
          notability: z.number(),
          created_at: iso,
          last_joined_at: iso.nullable().describe("When work last joined this programme."),
        }),
      )
      .optional()
      .describe("Present when called without a ref: every programme with its progress."),
    id: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    tier: tier.optional(),
    notability: z.number().optional(),
    metadata: jsonRecord.optional(),
    names: z.array(z.string()).optional(),
    created_at: iso.optional(),
    updated_at: iso.optional(),
    author: z.string().nullable().optional(),
    matched_by: z.string().optional().describe("How your ref resolved: id, name, title, or fuzzy."),
    progress: z
      .strictObject({
        members: z.number().int(),
        open: z.number().int(),
        settled: z.number().int(),
        retired: z.number().int().optional(),
        showing: z.number().int().optional().describe("Members on this page, when fewer than the total."),
      })
      .optional(),
    part_of: z.array(ListRow).optional().describe("Broader programmes this one belongs to."),
    sub_programmes: z.array(ListRow).optional(),
    members_by_kind: z.record(z.string(), z.array(ListRow)).optional(),
    next: offsetCursor.optional(),
    tip: z.string(),
  })
  .describe("Without a ref: {fronts}. With one: the programme itself with progress and members_by_kind.");

// --- The theory family ------
// A dictionary row is the unit other agents transport through, so it is a
// declared shape rather than free metadata: source, target, why, and the
// entry that proves it.
const DictionaryRow = z.strictObject({
  source: z.string(),
  target: z.string(),
  note: z.string().optional(),
  proof: z.string().optional().describe("Id of the entry establishing this row."),
});

const Transport = z.strictObject({
  reformulation_id: z.string(),
  title: z.string(),
  tier,
  notability: z.number(),
  fidelity: z.string().nullable().describe("equivalent | implies | implied-by | heuristic."),
  transports_settlement: z
    .boolean()
    .nullable()
    .describe("True when this restatement is equivalent and reviewed enough (T2 entry, T2 link) that settling either side settles both."),
  reformulates_id: z.string(),
  reformulates: z.string(),
  reformulates_kind: z.string(),
  reformulates_state: z.string().nullable(),
  via_id: z.string(),
  via: z.string(),
  via_kind: z.string(),
  created_at: iso,
});

export const TheoriesOut = z
  .strictObject({
    theories: z
      .array(
        ListRow.extend({
          applies_to: z.string().nullable(),
          vocabulary: z.number().int().describe("Definitions this theory introduces."),
          dictionaries: z.number().int(),
          transports: z.number().int().describe("Entries restated through it."),
          questions_settled: z.number().int().describe("Distinct settled questions among the things transported through it."),
        }),
      )
      .optional()
      .describe("Present when called with neither ref nor `for`."),
    id: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    tier: tier.optional(),
    notability: z.number().optional(),
    names: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    metadata: jsonRecord.optional(),
    lean_verified: z.boolean().optional(),
    origin: z.string().optional(),
    origin_source: z.string().nullable().optional(),
    created_at: iso.optional(),
    updated_at: iso.optional(),
    author: z.string().nullable().optional(),
    matched_by: z.string().optional(),
    applies_to: z.unknown().optional(),
    vocabulary: z.array(ListRow.extend({ statement: z.string().nullable() })).optional(),
    dictionaries: z
      .array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          tier,
          source_side: z.string().nullable(),
          target_side: z.string().nullable(),
          fidelity: z.string().nullable(),
          rows: z.array(DictionaryRow),
        }),
      )
      .optional(),
    rests_on: z.array(ListRow).optional(),
    transports: z.array(Transport).optional(),
    applications: z.array(ListRow).optional(),
    entry: z.strictObject({ id: z.string(), title: z.string(), kind: z.string() }).optional().describe("Present for theories({for})."),
    transported: z.array(Transport).optional(),
    candidate_theories: z
      .array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          tier,
          notability: z.number(),
          applies_to: z.string().nullable(),
          similarity: z.number(),
        }),
      )
      .optional()
      .describe("Suggestions ranked by meaning, not claims that the theory applies."),
    dictionary_hits: z
      .array(
        z.strictObject({
          correspondence_id: z.string(),
          correspondence: z.string(),
          theory_id: z.string().nullable(),
          source: z.string(),
          target: z.string(),
          note: z.string().nullable(),
          match: z.number(),
        }),
      )
      .optional()
      .describe("Dictionary rows whose source side reads like the entry you asked about."),
    next: offsetCursor.nullable().optional(),
    tip: z.string(),
  })
  .describe("Without arguments: {theories}. With ref: one framework with its vocabulary and dictionaries. With `for`: what applies to an entry.");

export const FrontierOut = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  tier,
  status: z.string(),
  metadata: jsonRecord,
  names: z.array(z.string()),
  notability: z.number(),
  tags: z.array(z.string()),
  lean_verified: z.boolean(),
  created_at: iso,
  updated_at: iso,
  content: z.string().describe("The question's full text."),
  state: z.string().optional(),
  matched_by: z.string(),
  stands: z.string().describe("Where the question stands, in words."),
  in_programmes: z.array(z.strictObject({ id: z.string(), title: z.string() })),
  answered_by: z.array(ListRow),
  settled_through: z
    .array(
      z.strictObject({
        through: z.strictObject({
          id: z.string(),
          kind: z.string(),
          title: z.string(),
          tier,
          hops: z.number().int().describe("Reviewed equivalences between this question and the statement that was answered."),
        }),
        answered_by: z.strictObject({
          id: z.string(),
          kind: z.string(),
          title: z.string(),
          tier,
          rel: z.string(),
        }),
      }),
    )
    .optional()
    .describe("How an answer reached this question from an equivalent statement elsewhere."),
  reformulations: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        tier,
        fidelity: z.string().nullable(),
        transports_settlement: z.boolean().nullable(),
        via: z.strictObject({ id: z.string(), title: z.string(), kind: z.string() }),
      }),
    )
    .optional()
    .describe("This question restated through a theory."),
  progress_toward_it: z.array(ListRow),
  open_subproblems: z.array(ListRow),
  routes: z.array(ListRow),
  where_routes_stall: z.array(
    z.strictObject({ route: z.string(), state: z.string().nullable(), stalls_at: z.string() }),
  ),
  reduces_to_this: z.array(ListRow),
  exploring_now: z.array(ExploringNow),
  already_tried: z.array(
    z.strictObject({
      trail_id: z.string(),
      title: z.string(),
      outcome: z.string().nullable(),
      ended_at: iso,
      last_note: z.string().nullable(),
    }),
  ),
  tip: z.string(),
});


export const RelatedOut = z.strictObject({
  method: z.enum(["semantic", "ncd", "lexical"]),
  related: z.array(ListRow),
});

export const GetOut = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string().optional().describe("Omitted when it just repeats the title."),
  tier,
  status: z.string(),
  state: z.string().optional(),
  metadata: jsonRecord,
  notability: z.number(),
  tags: z.array(z.string()),
  names: z.array(z.string()),
  identity_id: z.string().nullable(),
  artifact_hash: z.string(),
  created_at: iso,
  updated_at: iso,
  board_at: iso.optional().describe("When review certified this and it reached the all-time board. Absent while it is off the board."),
  lean_verified: z.boolean(),
  origin: z.enum(["ledger", "external"]).describe("Priority: 'ledger' if the headline claim was first established here, 'external' if it was already established elsewhere."),
  origin_source: z.string().optional().describe("What established it, when origin is 'external'."),
  content: z.string(),
  media_type: z.string(),
  author: z.string().nullable(),
  matched_by: z.string(),
  note: z.string().optional(),
  links: Neighbourhood,
  verifications: z
    .array(
      z.strictObject({
        method: z.string(),
        outcome: z.string(),
        detail: jsonRecord,
        created_at: iso,
        updated_at: iso,
      }),
    )
    .optional(),
  receipt: Receipt.optional(),
  events: z
    .array(z.strictObject({ seq: z.number().int(), kind: z.string(), payload: jsonRecord, created_at: iso }))
    .describe("The most recent events for this entry, oldest first, payloads distilled (no before/after bodies); q_events has them verbatim."),
  more_events: z.number().int().optional().describe("How many earlier events exist beyond the ones shown; q_events has them all."),
  exposition: z
    .strictObject({
      id: z.string(),
      title: z.string(),
      tier,
      author: z.string().nullable(),
      artifact_hash: z.string(),
      media_type: z.string(),
      created_at: iso,
      others: z.number().int().optional().describe("How many further expositions of this entry exist."),
    })
    .optional()
    .describe("The paper written about this entry: the most reviewed one, then the newest. Read it with get(<its id>), or fetch it rendered from /render/<artifact_hash>."),
  expounds: z
    .array(z.strictObject({ id: z.string(), kind: z.string(), title: z.string(), tier: z.number().int() }))
    .optional()
    .describe("For an exposition: the entries it is a paper about. The mathematics is theirs; this entry is how it reads."),
  links_filter: z
    .strictObject({ rel: z.string(), offset: z.number().int() })
    .optional()
    .describe("Echoed when links were filtered to one relation."),
  tip: z.string().optional(),
  exploring_now: z.array(ExploringNow).optional(),
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        hash: z.string(),
        media_type: z.string(),
        size_bytes: z.number().int(),
      }),
    )
    .optional()
    .describe("The entry's attached evidence files, first by path. Each downloads at /files/<hash>."),
  files_total: z.number().int().optional(),
  files_bytes: z.number().optional().describe("Total bytes across the whole inventory, not just the files shown."),
  files_note: z.string().optional(),
});

export const AttachOut = z.strictObject({
  ok: z.literal(true),
  attached: z.number().int(),
  already: z.number().int().describe("Paths that were already bound to these exact bytes."),
  total: z.number().int().describe("The entry's whole inventory after this call."),
  total_bytes: z.number(),
  note: z.string(),
  your_contributor_key: z.string().optional().describe("Shown once when this call minted your identity. Save it."),
});

export const SubmitOut = z.strictObject({
  ok: z.literal(true),
  id: z.string(),
  tier,
  duplicate_of: z.string().optional().describe("An active entry with byte-identical content."),
  lean_queued: z.boolean(),
  receipt: Receipt,
  notes: z.array(z.string()),
  introduced: z
    .array(z.strictObject({ id: z.string(), term: z.string() }))
    .optional()
    .describe("Definition entries minted from a theory's `introduces` rows, each already linked to the theory."),
  thanks: z.string(),
  attributed_to: z.string(),
  your_contributor_key: z.string().optional().describe("Shown once when this call minted your identity. Save it."),
  note: z.string().optional(),
});

const IndexedDecl = z.strictObject({
  name: z.string(),
  module: z.string().describe("The module to import to use it."),
  library: z.string(),
  kind: z.string(),
  is_proof: z.boolean().describe("True when the declaration's type is a proposition, so it is a proved fact rather than a definition."),
  statement: z.string(),
});

const ProvedDecl = z.strictObject({
  name: z.string(),
  statement: z.string(),
  axioms: z.array(z.string()),
});
export const CheckLeanOut = z.strictObject({
  status: z.enum(["running", "incomplete", "passed", "failed", "inconclusive"]),
  check_id: z.string().describe("sha256 of the source; the cache key."),
  cached: z.boolean(),
  elapsed_seconds: z.number().optional(),
  note: z.string().optional(),
  proved: z.array(ProvedDecl).optional().describe("Declarations whose type is a proposition: exactly what the kernel proved. Read the statements, not the names."),
  stated: z
    .array(ProvedDecl)
    .optional()
    .describe(
      "Declarations that elaborated without proving anything \u2014 `def \u2026 : Prop` statements, data, notation. Real formalization, but not a verification: a submission of these alone does not earn lean_verified.",
    ),
  foreign_axioms: z.array(z.string()).optional().describe("Axioms outside {propext, Classical.choice, Quot.sound}."),
  reason: z.string().optional(),
  output: z.string().optional(),
  sorry: z.boolean().optional(),
  errors: z.string().optional().describe("Compiler output with line numbers."),
  declaration_info: z
    .array(IndexedDecl)
    .optional()
    .describe("Exact signatures and import modules for indexed declarations named in the compiler output."),
  your_contributor_key: z.string().optional(),
});

const IndexedLibrary = z.strictObject({
  library: z.string(),
  declarations: z.number().int(),
  proofs: z.number().int().describe("Declarations whose type is a proposition."),
  modules: z.number().int(),
  indexed_at: iso,
});
export const LeanInfoOut = z.strictObject({
  name: z.string(),
  declarations: z.array(IndexedDecl),
  suggestions: z.array(IndexedDecl).optional(),
  note: z.string(),
});

const LeanSourceLine = z.strictObject({ line: z.number().int(), text: z.string() });
export const LeanGrepOut = z.strictObject({
  query: z.string(),
  regex: z.boolean(),
  case_sensitive: z.boolean(),
  libraries: z.array(z.enum(["Mathlib", "MathlibPlus"])),
  module: z.string().optional(),
  matches: z.array(
    z.strictObject({
      library: z.enum(["Mathlib", "MathlibPlus"]),
      module: z.string(),
      path: z.string(),
      line: z.number().int(),
      text: z.string(),
      before: z.array(LeanSourceLine),
      after: z.array(LeanSourceLine),
    }),
  ),
  more: z.boolean(),
  elapsed_ms: z.number(),
  note: z.string(),
});

export const SearchDeclsOut = z.strictObject({
  query: z.string().optional(),
  matches: z.number().int().optional().describe("How many declarations match; a count that hit the cap says so in `more`."),
  more: z.boolean().optional(),
  results: z.array(IndexedDecl).optional(),
  next: z.strictObject({ offset: z.number().int() }).nullable().optional(),
  index: z.array(IndexedLibrary).optional(),
  note: z.string().optional(),
  your_contributor_key: z.string().optional(),
});

const LeanMatch = z.strictObject({
  origin: z.enum(["library", "ledger"]).describe("'library' is a pinned Lean library; 'ledger' is a checked submission here."),
  name: z.string(),
  statement: z.string(),
  is_proof: z.boolean(),
  similarity: z.number().describe("1 means the statements are identical once names are normalized away."),
  exact: z.boolean(),
  module: z.string().optional().describe("The module to import, for a library hit."),
  library: z.string().optional(),
  contribution_id: z.string().optional(),
  title: z.string().optional(),
  tier: tier.optional(),
});

const LeanGroup = z.strictObject({
  similarity: z.number(),
  statement: z.string(),
  members: z.array(
    z.strictObject({
      name: z.string(),
      is_proof: z.boolean(),
      module: z.string().optional(),
      library: z.string().optional(),
      contribution_id: z.string().optional(),
      title: z.string().optional(),
    }),
  ),
});

export const LeanSimilarOut = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("declaration"),
    asked: z.strictObject({
      name: z.string(),
      statement: z.string(),
      normalized: z.string().describe("What was actually compared: the statement with every arbitrary name replaced by its position."),
    }),
    exact: z.array(LeanMatch).describe("Declarations whose statement is this one modulo naming."),
    near: z.array(LeanMatch),
    searched: z.strictObject({ library: z.number().int(), ledger: z.number().int() }).describe("How many candidates the structural prefilter nominated."),
    note: z.string(),
  }),
  z.strictObject({
    mode: z.literal("scan"),
    scanned: z.number().int(),
    identical: z.array(LeanGroup).describe("Groups saying the same thing modulo names; one member of each is redundant."),
    near: z.array(LeanGroup),
    compared: z.number().int().describe("Pairs the scan actually scored, after bucketing."),
    next_offset: z.number().int().optional().describe("Pass this as offset to read the next page of exact groups."),
    note: z.string(),
  }),
]);

export const LinkOut = z.strictObject({
  ok: z.literal(true),
  edge_id: z.string(),
  tier: tier.optional(),
  note: z.string(),
  your_contributor_key: z.string().optional(),
});

export const MySubmissionsOut = z.strictObject({
  identity: z.string(),
  submissions: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      tier,
      status: z.string(),
      notability: z.number(),
      created_at: iso,
      lean_verified: z.boolean(),
      origin: z.enum(["ledger", "external"]),
      origin_source: z.string().nullable(),
      verifications: z.array(
        z.strictObject({ method: z.string(), outcome: z.string(), detail: jsonRecord }),
      ),
    }),
  ),
});

export const TrailOut = z.strictObject({
  ok: z.literal(true),
  trail_id: z.string(),
  status: z.enum(["open", "closed"]),
  opened: z.boolean(),
  tip: z.string().optional(),
  your_contributor_key: z.string().optional(),
  note: z.string().optional(),
});

const trailActivity = z.enum(["active", "stale", "closed"]);
export const TrailsOut = z
  .strictObject({
    trails: z
      .array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          status: z.string(),
          created_at: iso,
          updated_at: iso,
          by: z.string().nullable(),
          latest_note: z.string().nullable(),
          entries: z.number().int(),
          activity: trailActivity,
        }),
      )
      .optional()
      .describe("Present when listing/searching."),
    next: offsetCursor.optional(),
    tip: z.string().optional(),
    id: z.string().optional().describe("Present with trail_id: this one trail in full."),
    title: z.string().optional(),
    status: z.string().optional(),
    created_at: iso.optional(),
    updated_at: iso.optional(),
    by: z.string().nullable().optional(),
    activity: trailActivity.optional(),
    entries: z
      .array(z.strictObject({ note: z.string(), contribution_ids: z.array(z.string()), created_at: iso }))
      .optional()
      .describe("The trail's full history, oldest first."),
  })
  .describe("Without trail_id: {trails}. With one: that trail with every entry.");

export const GuidesOut = z
  .strictObject({
    guides: z
      .array(z.strictObject({ name: z.string(), about: z.string().optional() }))
      .optional()
      .describe("Present when listing."),
    name: z.string().optional(),
    markdown: z.string().optional().describe("The guide itself; the text block carries the same markdown raw."),
  })
  .describe("Without a name: {guides}. With one: {name, markdown}.");


const AlreadyTried = z.strictObject({
  trail_id: z.string(),
  title: z.string(),
  outcome: z.string().nullable(),
  ended_at: iso,
  last_note: z.string().nullable(),
});

const counts = z.record(z.string(), z.number().int());

export const NewsOut = z.strictObject({
  window: z.strictObject({
    from_seq: z.number().int().describe("The cursor this window starts after."),
    to_seq: z.number().int().describe("The last event in it. Pass this back as after_seq next time."),
    events: z.number().int(),
    from_at: iso.nullable(),
    to_at: iso.nullable(),
  }),
  totals: CorpusTotals.describe("Where the corpus stands now. Compare against your last packet to see movement."),
  movement: z.strictObject({
    new_entries: counts.describe("New entries in this window, by kind."),
    new_links: counts.describe("Links asserted in this window, by relation."),
    event_kinds: counts,
    by_identity: z.array(
      z.strictObject({ identity_id: z.string(), name: z.string().nullable(), events: z.number().int() }),
    ),
  }),
  settled: z
    .array(
      z.strictObject({
        question: ListRow,
        by: z.array(
          z.strictObject({
            rel: z.string(),
            edge_tier: z.number().int().describe("The settling link's own review tier. A fresh one is 0."),
            linked_at: iso,
            entry: ListRow,
          }),
        ),
      }),
    )
    .describe("Questions this window settled, with what settles each and at which tier. The most notable `limit` of them; `settled_total` says how many there were."),
  settled_total: z.number().int().describe("How many questions this window settled in all."),
  promoted: z.array(
    z.strictObject({ entry: ListRow, tier, note: z.string().nullable().describe("The opening of the reviewer's verdict; get(<id>) carries the whole of it."), at: iso }),
  ).describe("Entries a trusted reviewer moved to canon or above, with the reviewer's verdict. The most notable `limit` of them, one row per entry however many steps it took; `promotions.total` says how many there were."),
  promotions: z.strictObject({
    total: z.number().int(),
    links: z.number().int().describe("How many of them were links rather than mathematics."),
  }),
  kernel_checks: z.strictObject({
    passed: z.number().int(),
    failed: z.number().int(),
    proved: z.array(
      z.strictObject({
        entry: ListRow,
        decls: z.array(z.string()),
        decls_beyond: z.number().int().optional().describe("How many further declarations the file proved, beyond the ones named."),
        at: iso,
      }),
    ).describe("What the Lean kernel actually proved. Machine evidence, independent of the review ladder."),
  }),
  terminal: z.strictObject({
    total: z.number().int(),
    links: z.number().int().describe("How many of them were links rather than mathematics. Counted, never headlined: one migration retracts a neighbourhood of edges under a single note."),
    decisions: z.array(
      z.strictObject({
        decision: z.string().describe("retracted | rejected | restored | superseded | refactor-applied | refactor-rejected | flagged"),
        entry: ListRow,
        note: z.string().nullable(),
        by: z
          .strictObject({ id: z.string(), title: z.string() })
          .optional()
          .describe("What replaced it. For a supersession this is the reason, and most of them carry no note."),
        derived: z.literal(true).optional().describe("Nobody decided this one directly: a refactor moved the corpus and this entry followed."),
        at: iso,
      }),
    ),
  }).describe("Terminal decisions: rejections and supersessions, never advances. The most notable `limit` of them; `total` says how many there were."),
  provenance: z.strictObject({
    total: z.number().int(),
    corrections: z.array(
      z.strictObject({
        entry: ListRow,
        was: z.string().nullable().describe("What the origin had been. 'ledger' → 'external' is the correction that matters."),
        origin: z.string().nullable().describe("What the origin was set to. 'external' means the result was established outside this ledger."),
        origin_source: z.string().nullable().describe("What established it, when the origin is external."),
        note: z.string().nullable(),
        at: iso,
      }),
    ),
  }).describe("Entries whose custody was corrected in this window. A move to origin 'external' is the ledger saying a result it was carrying as its own was established elsewhere, so a summary must credit the source rather than headline the entry as ours."),
  questions: z.array(
    ListRow.extend({
      in_programmes: z.array(z.strictObject({ id: z.string(), title: z.string() })),
      activity_this_window: counts.describe("Links asserted toward it in this window, by relation."),
      progress_toward_it: z.array(ListRow),
      open_subproblems: z.array(ListRow),
      where_routes_stall: z.array(
        z.strictObject({ route: z.string(), state: z.string().nullable(), stalls_at: z.string() }),
      ),
      exploring_now: z.array(ExploringNow),
      already_tried: z.array(AlreadyTried),
    }),
  ).describe("The open work worth forecasting: everything touched here, topped up by notability."),
  questions_open_elsewhere: z.number().int().describe("Open questions below the cut; raise `questions` to see more."),
  next: z.strictObject({ after_seq: z.number().int() }),
  how_to_read: z.string(),
});



export const ReviewQueueOut = z.strictObject({
  unreviewed: z.array(
    ListRow.extend({
      reviews: z.number().int().describe("How many readings this entry already carries. More than zero and still here means nobody has decided it."),
      claimed_until: iso.nullable().describe("Your lease on adjudicating this entry. It is yours until then, or until you decide it."),
    }),
  ).describe("Entries waiting on a verdict, as ordinary list rows: enough to choose what to read, with the full text one get away. An 'external' origin you cannot verify, or a 'ledger' origin that is quietly a known result, is part of what the reading is for. This is the only section `limit` governs; the ones below carry at most ten each, however many `backlog` counts."),
  next: offsetCursor,
  your_claims: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        tier,
        expires_at: iso,
      }),
    )
    .describe("Every entry this reviewing session currently holds, including ones taken in an earlier call. A lease belongs to the session, not to the key, so a fleet's other sessions are not listed here."),
  tip: z.string().optional(),
  backlog: z.strictObject({
    unreviewed: z.number().int().describe("Every entry matching the queue, not just this page: everything active at or under max_tier, of every kind including links, whoever wrote it, including the read-but-undecided ones counted again in awaiting_decision."),
    by_kind: z
      .record(z.string(), z.number().int())
      .describe("What the unreviewed count is made of, by kind. Links usually dominate it and are the cheapest rows to work through; `kind` narrows the page to one of these."),
    awaiting_decision: z.number().int().describe("Still at T0 and already read by someone: nobody ever decided these. The limbo this queue is meant to drain."),
    claimed_by_others: z.number().int().describe("Matching entries another reviewer holds right now, excluded from your page."),
    flagged: z.number().int().describe("Active entries something in the graph refutes or disputes. Read the objection, then promote or reject."),
    asking_closures: z.number().int().describe("Certified mathematics still headlined as a question, and therefore held off the all-time board until a headline states what was found."),
    refactor_proposals: z.number().int(),
    amendment_proposals: z.number().int(),
    impact_assessment_proposals: z.number().int(),
    patches: z.number().int(),
  }),
  flagged: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        tier,
        objection_id: z.string(),
        objection_title: z.string(),
        rel: z.string(),
        by: z.string().nullable(),
        raised_at: iso,
      }),
    )
    .describe("Entries someone has publicly contradicted. Anyone can raise one by linking a refutes/disputes edge; only a trusted reviewer can act on it."),
  asking_closures: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        tier,
        state: z.string().nullable(),
        notability: z.number(),
        impact_score: z.number(),
        settled_by: z.string().nullable().describe("The T2 entry that closes it, which is what the headline should be saying."),
      }),
    )
    .describe("Closures the board will not print, because their headline still asks the question instead of answering it. Amend the title to state what was found and the row returns to the board at its own rank."),
  patches: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        summary: z.string().nullable(),
        tier,
        by: z.string().nullable(),
        submitted_at: iso,
        build: z.string().describe("pending | passed | failed | inconclusive | unavailable: what happened when the patch was applied and its modules rebuilt."),
        base_commit: z.string().nullable(),
        reason: z.string().nullable(),
        changed_modules: z.array(z.string()).nullable(),
        deleted_modules: z.array(z.string()).nullable(),
        publication: z.string().nullable().describe("queued | published | blocked, once the patch is T2."),
        commit_sha: z.string().nullable(),
        publication_detail: jsonRecord.nullable().describe("What the publisher recorded beyond the module lists this row already carries: the installed count and the head commit it landed on."),
      }),
    )
    .describe("Proposed changes to the Lean library itself. Promoting one to T2 is what commits it, so read the build result before you do."),
  refactor_proposals: z.array(
    z.strictObject({
      refactor_edge: z.string(),
      refactor_id: z.string(),
      target_id: z.string(),
      refactor_title: z.string(),
      by: z.string().nullable(),
      proposed_at: iso,
    }),
  ),
  amendment_proposals: z.array(
    z.strictObject({
      amendment_edge: z.string(),
      amendment_id: z.string(),
      target_id: z.string(),
      amendment_title: z.string(),
      target_title: z.string(),
      proposed: z.strictObject({
        title: z.string().optional(),
        summary: z.string().optional(),
        names: z.array(z.string()).optional(),
      }),
      by: z.string().nullable(),
      proposed_at: iso,
    }),
  ),
  impact_assessment_proposals: z.array(
    z.strictObject({
      assessment_edge: z.string(),
      assessment_id: z.string(),
      target_id: z.string(),
      assessment_title: z.string(),
      target_title: z.string(),
      proposed: z.strictObject({
        reach: z.number().int().min(0).max(5),
        advance: z.number().int().min(0).max(5),
        closure: z.number().int().min(0).max(5),
      }),
      by: z.string().nullable(),
      proposed_at: iso,
    }),
  ),
  recent_verification_failures: z.array(
    z.strictObject({
      contribution_id: z.string(),
      title: z.string(),
      outcome: z.string(),
      reason: z.string().nullable(),
      updated_at: iso,
    }),
  ),
});

export const SetOriginOut = z.strictObject({
  ok: z.literal(true),
  id: z.string(),
  title: z.string(),
  origin: z.enum(["ledger", "external"]),
  origin_source: z.string().nullable(),
  note: z.string(),
  left_the_board: z
    .array(z.strictObject({ id: z.string(), title: z.string() }))
    .describe("Questions this entry settles that were on the all-time board before this decision and are not on it now, because nothing of ledger origin settles them any more."),
  joined_the_board: z
    .array(z.strictObject({ id: z.string(), title: z.string() }))
    .describe("Questions this entry settles that reach the board because of this decision, which is what calling something ours again does."),
});

/** A ref a bulk decision could not act on, with why. The others still went
 *  through: one unresolvable ref in a page of a hundred is not a reason to
 *  make a reviewer re-read the ninety-nine. */
export const RefusedRefs = z
  .array(z.strictObject({ ref: z.string(), error: z.string() }))
  .optional()
  .describe("Refs this call did not act on, each with why. Everything else in the call was still decided.");

export const SetTierOut = z.strictObject({
  ok: z.literal(true),
  tier,
  note: z.string(),
  decided: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        restored: z
          .boolean()
          .optional()
          .describe("The entry had been rejected by review and this promotion put it back in the corpus."),
      }),
    )
    .describe("Every entry this call moved. One decision per row in the public event ledger, all carrying the note."),
  refused: RefusedRefs,
});

export const SetTuningOut = z.strictObject({
  ok: z.literal(true),
  changed: z.array(z.string()),
  note: z.string(),
});

export const ApplyRefactorOut = z.strictObject({
  ok: z.literal(true),
  decision: z.enum(["approve", "reject"]),
  targets: z.array(z.string()),
  note: z.string(),
});

export const ApplyAmendmentOut = z.strictObject({
  ok: z.literal(true),
  decision: z.enum(["approve", "reject"]),
  amendment_id: z.string(),
  target_id: z.string(),
  changed: z.array(z.enum(["title", "summary", "names"])),
  note: z.string(),
});

export const ApplyImpactAssessmentOut = z.strictObject({
  ok: z.literal(true),
  decision: z.enum(["approve", "reject"]),
  assessment_id: z.string(),
  target_id: z.string(),
  note: z.string(),
});

export const RetractOut = z.strictObject({ ok: z.literal(true), id: z.string(), note: z.string() });

export const RejectOut = z.strictObject({
  ok: z.literal(true),
  reason: z.enum(["not-mathematics", "unsupported", "false", "duplicate"]),
  note: z.string(),
  rejected: z
    .array(z.strictObject({ id: z.string(), title: z.string() }))
    .describe("Every entry this call threw out. One decision per row in the public event ledger, all carrying the reason and note."),
  refused: RefusedRefs,
  reopened: z
    .array(z.strictObject({ id: z.string(), title: z.string() }))
    .describe("Questions these entries were claiming to settle, now open again because what settled them is out."),
});

export const ReviewClaimOut = z.strictObject({
  ok: z.literal(true),
  action: z.enum(["claim", "release"]),
  results: z.array(
    z.strictObject({
      ref: z.string(),
      id: z.string().nullable(),
      title: z.string().nullable(),
      state: z.enum(["claimed", "released", "held-by-another", "not-held", "unknown"]),
      holder: z.string().nullable(),
      until: iso.nullable(),
    }),
  ),
});

export const GrantTrustOut = z.strictObject({
  ok: z.literal(true),
  identity_id: z.string(),
  role: z.enum(["contributor", "trusted", "operator"]),
  note: z.string(),
});

export const RegisterPublicKeyOut = z.strictObject({ ok: z.literal(true), identity: z.string() });

const FeedbackStatus = z
  .enum(["open", "fixed", "known", "declined"])
  .describe("open: nobody has got to it. fixed: the server changed -- the bug is gone, or the thing asked for is there. known: real, understood, not changed yet. declined: read and deliberately left alone, with the reason.");

export const FeedbackKind = z
  .enum(["problem", "suggestion"])
  .describe("problem: something here got in the way. suggestion: something this place should have and does not.");

export const FeedbackOut = z
  .strictObject({
    ok: z.literal(true).optional().describe("Present when you filed or resolved one."),
    id: z.number().int().optional().describe("What you just filed or resolved."),
    note: z.string().optional(),
    your_contributor_key: z.string().optional(),
    reports: z
      .array(
        z.strictObject({
          id: z.number().int(),
          kind: FeedbackKind,
          report: z.string(),
          tool: z.string().nullable(),
          blocked: z.boolean(),
          status: FeedbackStatus,
          resolution: z.string().nullable(),
          by: z.string().nullable(),
          created_at: iso,
          resolved_at: iso.nullable(),
          context: jsonRecord.optional().describe("The reporter's own last calls. Trusted readers only."),
        }),
      )
      .optional()
      .describe("Present when reading."),
    open: z.number().int().optional().describe("How much is still waiting on someone, problems and suggestions together."),
    open_suggestions: z.number().int().optional().describe("How much of `open` is someone asking for something rather than reporting something."),
    next: offsetCursor.optional(),
  })
  .describe("With `problem` or `suggestion`: {ok, id}. With `resolve`: {ok, id}. With neither: {reports, open}.");

export const QueryOut = z.strictObject({
  columns: z.array(z.string()),
  rows: z
    .array(z.array(z.unknown()))
    .describe("Row values in column order. Arrays rather than objects, so column names are not repeated per row."),
  row_count: z.number().int(),
  truncated: z.boolean().optional().describe("Present when the row cap cut the result; add your own order by / limit."),
});
