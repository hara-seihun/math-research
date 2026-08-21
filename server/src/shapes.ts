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
    tier: z.number().int().describe("Review tier: 0 recorded, 1 confirmed, 2 canon, 3 published."),
    lean_verified: z.literal(true).optional(),
    notability: z.number(),
    ranking: z
      .strictObject({
        built_on_by: z.number().int().describe("Distinct active entries linking to this one."),
        settles: z.number().int().describe("Distinct active questions this entry answers, proves, disproves, refutes, or resolves."),
      })
      .optional()
      .describe("Transparent graph signals behind notability-ranked browse results."),
    summary: z.string().optional().describe("Shortened; get(<ref>) has the full text."),
    topics: z.array(z.string()).optional(),
    names: z.array(z.string()).optional(),
    status: z.string().optional().describe("Present only when not 'active' (retracted/superseded)."),
    created_at: iso.optional(),
    rel: z.string().optional().describe("The relation this row arrived through, when listed via a link."),
    edge_tier: z.number().int().optional().describe("The linking edge's own review tier."),
    linked_at: iso.optional().describe("When the link was asserted."),
    joined_at: iso.optional().describe("When this member joined the front."),
    matched: z.string().optional().describe("How search matched it: 'every term', 'some terms', or 'fuzzy'."),
    similarity: z.number().optional(),
    answers: z.number().int().optional().describe("How many active entries answer/prove/refute this."),
    settled_by: z
      .array(z.strictObject({ id: z.string(), kind: z.string(), title: z.string(), tier: z.number().int() }))
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
  tier: z.number().int(),
  notability: z.number(),
  edge_tier: z.number().int(),
  status: z.string(),
  linked_at: iso,
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
  .describe("The typed neighbourhood, capped per relation, each link carrying its own review tier and assertion time.");

const Receipt = z
  .strictObject({ payload: jsonRecord, server_signature: z.string() })
  .describe("Server-signed Ed25519 receipt binding artifact, identity, and time.");

const KindCount = z.strictObject({
  kind: z.string(),
  n: z.number().int(),
  states: z.record(z.string(), z.number().int()).optional().describe("Work-state breakdown, when the kind has one."),
  means: z.string().optional().describe("What this kind is here."),
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
    kinds: z.array(KindCount),
    by_tier: z.array(z.strictObject({ tier: z.number().int(), n: z.number().int() })),
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
    tier: z.number().int().optional(),
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

export const FrontierOut = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  tier: z.number().int(),
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
  tier: z.number().int(),
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
  lean_verified: z.boolean(),
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
    .describe("The most recent events for this entry, oldest first."),
  more_events: z.number().int().optional().describe("How many earlier events exist beyond the ones shown; q_events has them all."),
  links_filter: z
    .strictObject({ rel: z.string(), offset: z.number().int() })
    .optional()
    .describe("Echoed when links were filtered to one relation."),
  tip: z.string().optional(),
  exploring_now: z.array(ExploringNow).optional(),
});

export const SubmitOut = z.strictObject({
  ok: z.literal(true),
  id: z.string(),
  tier: z.number().int(),
  duplicate_of: z.string().optional().describe("An active entry with byte-identical content."),
  lean_queued: z.boolean(),
  receipt: Receipt,
  notes: z.array(z.string()),
  thanks: z.string(),
  attributed_to: z.string(),
  your_contributor_key: z.string().optional().describe("Shown once when this call minted your identity. Save it."),
  note: z.string().optional(),
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
  your_contributor_key: z.string().optional(),
});

export const LinkOut = z.strictObject({
  ok: z.literal(true),
  edge_id: z.string(),
  tier: z.number().int().optional(),
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
      tier: z.number().int(),
      status: z.string(),
      notability: z.number(),
      created_at: iso,
      lean_verified: z.boolean(),
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
  totals: z.strictObject({
    entries: z.number().int(),
    links: z.number().int(),
    programmes: z.number().int(),
    open_questions: z.number().int(),
    lean_verified: z.number().int(),
    active_trails: z.number().int(),
  }).describe("Where the corpus stands now. Compare against your last packet to see movement."),
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
    .describe("Questions this window settled, with what settles each and at which tier."),
  promoted: z.array(
    z.strictObject({ entry: ListRow, tier: z.number().int(), note: z.string().nullable(), at: iso }),
  ).describe("Entries a trusted reviewer moved to canon or above, with the reviewer's verdict."),
  promotions: z.strictObject({
    total: z.number().int(),
    links: z.number().int().describe("How many of them were links rather than mathematics."),
  }),
  kernel_checks: z.strictObject({
    passed: z.number().int(),
    failed: z.number().int(),
    proved: z.array(
      z.strictObject({ entry: ListRow, decls: z.array(z.string()), at: iso }),
    ).describe("What the Lean kernel actually proved. Machine evidence, independent of the review ladder."),
  }),
  terminal: z.strictObject({
    total: z.number().int(),
    decisions: z.array(
      z.strictObject({
        decision: z.string().describe("retracted | superseded | refactor-applied | refactor-rejected | flagged"),
        entry: ListRow,
        note: z.string().nullable(),
        at: iso,
      }),
    ),
  }).describe("Terminal decisions: rejections and supersessions, never advances."),
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
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      summary: z.string(),
      tier: z.number().int(),
      notability: z.number(),
      created_at: iso,
      lean_verified: z.boolean(),
    }),
  ),
  next: offsetCursor,
  backlog: z.strictObject({
    unreviewed: z.number().int(),
    refactor_proposals: z.number().int(),
    amendment_proposals: z.number().int(),
  }),
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

export const SetTierOut = z.strictObject({
  ok: z.literal(true),
  id: z.string(),
  tier: z.number().int(),
  note: z.string(),
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

export const RetractOut = z.strictObject({ ok: z.literal(true), id: z.string(), note: z.string() });

export const GrantTrustOut = z.strictObject({
  ok: z.literal(true),
  identity_id: z.string(),
  role: z.enum(["contributor", "trusted", "operator"]),
  note: z.string(),
});

export const RegisterPublicKeyOut = z.strictObject({ ok: z.literal(true), identity: z.string() });

export const QueryOut = z.strictObject({
  columns: z.array(z.string()),
  rows: z
    .array(z.array(z.unknown()))
    .describe("Row values in column order. Arrays rather than objects, so column names are not repeated per row."),
  row_count: z.number().int(),
  truncated: z.boolean().optional().describe("Present when the row cap cut the result; add your own order by / limit."),
});
