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
 *  JSON in the text block; the SDK skips schema validation for it. */
const jsonText = (value: unknown) => ({
  type: "text" as const,
  text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
});
export const structured = (value: unknown) => ({
  content: [jsonText(value)],
  // Round-trip so structuredContent is exactly the wire shape: Dates become
  // ISO strings and undefined-valued keys are dropped, same as the text block.
  structuredContent: JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
});
export const fail = (value: unknown) => ({ content: [jsonText(value)], isError: true as const });

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
    score: z.number().optional(),
    answers: z.number().int().optional().describe("How many active entries answer/prove/refute this."),
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
    out: z.record(z.string(), z.array(NeighbourLink)).describe("Outgoing links, grouped by relation."),
    in: z.record(z.string(), z.array(NeighbourLink)).describe("Incoming links, grouped by relation."),
  })
  .describe("The typed neighbourhood, each link carrying its own review tier and assertion time.");

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
  what_is_here: z.strictObject({ note: z.string(), kinds: z.array(KindCount) }),
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
  query: z.string(),
  results: z.array(ListRow),
  matched: z.strictObject({
    every_term: z.number().int().describe("How many results matched every term."),
    weaker: z.number().int().describe("How many are partial or fuzzy matches."),
  }),
  next: offsetCursor,
  tip: z.string(),
});

export const ResolveOut = z.strictObject({
  match: z.enum(["exact", "fuzzy", "none"]),
  results: z.array(ListRow),
  tip: z.string().optional(),
});

export const BrowseOut = z.strictObject({
  total: z.number().int().describe("How many entries match the filter, beyond this page."),
  results: z.array(ListRow),
  next: offsetCursor,
  tip: z.string(),
});

export const TopicsOut = z.strictObject({
  topics: z.array(z.strictObject({ topic: z.string(), n: z.number().int(), canon: z.number().int() })),
  untagged: z.number().int(),
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

export const ContextOut = z.strictObject({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  tier: z.number().int(),
  status: z.string(),
  state: z.string().nullable(),
  notability: z.number(),
  tags: z.array(z.string()),
  names: z.array(z.string()),
  metadata: jsonRecord,
  lean_verified: z.boolean(),
  created_at: iso,
  updated_at: iso,
  author: z.string().nullable(),
  matched_by: z.string(),
  links: Neighbourhood,
  exploring_now: z.array(ExploringNow),
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
  events: z.array(
    z.strictObject({ seq: z.number().int(), kind: z.string(), payload: jsonRecord, created_at: iso }),
  ),
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
  proved: z.array(ProvedDecl).optional().describe("Exactly what the kernel accepted. Read the statements, not the names."),
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

export const EventsOut = z.strictObject({
  events: z.array(
    z.strictObject({
      seq: z.number().int(),
      kind: z.string(),
      contribution_id: z.string().nullable(),
      identity_id: z.string().nullable(),
      payload: jsonRecord,
      created_at: iso,
    }),
  ),
  next: z.strictObject({ after_seq: z.number().int() }).nullable(),
});

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

export const StatsOut = z.strictObject({
  totals: z.strictObject({
    entries: z.number().int(),
    links: z.number().int(),
    programmes: z.number().int(),
    open_questions: z.number().int(),
    identities: z.number().int(),
    open_trails: z.number().int(),
    events: z.number().int(),
    lean_verified: z.number().int(),
  }),
  by_kind: z.array(KindCount.extend({ avg_tier: z.number() })),
  by_tier: z.array(z.strictObject({ tier: z.number().int(), n: z.number().int() })),
  top_topics: z.array(z.strictObject({ topic: z.string(), n: z.number().int() })),
  tip: z.string(),
});

export const GetTuningOut = z.strictObject({
  notability_weights: jsonRecord,
  notability_formula: z.string(),
  topic_rules: z.array(z.strictObject({ topic: z.string(), pattern: z.string(), ord: z.number().int() })),
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

export const RetractOut = z.strictObject({ ok: z.literal(true), id: z.string(), note: z.string() });

export const GrantTrustOut = z.strictObject({
  ok: z.literal(true),
  identity_id: z.string(),
  role: z.enum(["contributor", "trusted", "operator"]),
  note: z.string(),
});

export const RegisterPublicKeyOut = z.strictObject({ ok: z.literal(true), identity: z.string() });
