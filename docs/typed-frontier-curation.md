# Typed frontier curation plan

Status: design only. Hara deferred the decision and any implementation on
2026-08-24, intending to return on 2026-08-25 or 2026-08-26. No schema, server,
ledger, or orchestrator change has started.

This note records the diagnosis, the target data model, and a way to rebuild the
corpus in place with one orchestrator lane. It is deliberately more complete
than the TODO entry so the next session can begin here rather than reconstruct
the discussion.

## Why the current model is not enough

Frontier reads currently derive from free-text contribution kinds, generic
edges, alias arrays, and direct `in-front` membership. That retains everything
people submit, but it does not reliably state the current position of a
research programme.

The finite undirected CI classification is the acceptance case. On 2026-08-24,
the ledger presented A3 and A6 as `settled` and A5 as `open`. The underlying
record said something more qualified:

- A6 had an active T1 closure theorem and a separate T0 `answers` edge.
- A5 had been claimed closed, promoted to T1, then rejected as unsupported and
  reopened.
- A3 had only a T0 closure claim and T0 `answers` edge. Its body relied on the
  rejected A5 assembly and rejected corner theorem, but those dependencies
  existed only in prose. Their rejection could not flag A3.

The canonical cells are `4868a490` for A3, `e9480a56` for A5, and `1e27d6ec`
for A6. Their closure entries are `c488547b`, `2c2ef240`, and `bd4bca99`.
`refresh_state` in `schema.sql`, the `fronts` and `frontier` handlers in
`server/src/index.ts`, and settlement reconstruction in `server/src/news.ts`
are the current implementation paths.

The defects are structural:

- any active T0 settling edge changes a question to `settled`;
- the resolving theorem and its claim of exact coverage climb review
  independently;
- no durable transition records the moment a cell is claimed, confirmed,
  rejected, or reopened;
- a programme is a flat collection of heterogeneous entries without roles;
- stable cell codes such as `CI/A3` are aliases rather than programme-scoped
  identifiers;
- results may belong to a parent front, a child front, or no front at all;
- immutable summaries and old routes can still say `open` beside a derived
  `settled` state;
- proof-critical dependencies can remain hidden in the body;
- front summaries and detailed reads disagree about whether conjectures count
  as cells.

Search ranking cannot repair contradictions already encoded in state and
membership.

## What the corpus shape implies

A live census on 2026-08-24 found:

- 74,945 active non-edge entries and 77 fronts;
- 587 active problems or conjectures, 387 of them in no front;
- 3,075 direct front memberships covering 2,985 distinct entries;
- 130 distinct active settlement pairs, with 103 resolving entries in no
  front;
- 73 settlement pairs whose target has a front but whose resolving source does
  not;
- 44,751 active `part-of` edges, only five of which connect fronts;
- 46,768 statements, with 42,471 nested under 5,461 result entries.

These counts rule out two tempting migrations. One agent per front misses most
questions and most resolving work. One agent per row tears extracted statements
away from the result that gives them meaning. Connected components are not a
useful partition either, because `part-of`, `uses`, and shared results cross the
boundaries the frontier wants.

The natural unit for most of the mathematical corpus is a result bundle: one
root result, its body, its extracted statements, amendments, reviews, outgoing
dependencies, and claimed coverage. The natural units around it are programmes
and exact questions.

## Target model

Keep append-only events, artifacts, authorship, receipts, and the submitted
links as provenance. Typed domain records become the only authority for current
frontier reads.

The durable model needs at least:

- canonical mathematical claims with exact statements and structured scope;
- programmes and ordered frontier nodes with a unique programme-scoped code,
  parent, node type, and target claim;
- role-bearing attachment for resolutions, routes, evidence, dependencies,
  and previous attempts;
- resolution assertions naming outcome, exact target, complete or partial
  coverage, and proof-critical dependencies;
- one review package covering the resolving claim and its assertion of exact
  coverage;
- typed claim dependencies whose failure makes dependent resolutions
  unhealthy;
- explicit frontier transitions for assertion, confirmation, canonization,
  dispute, rejection, and reopening.

A frontier row must distinguish open, resolution claimed at T0, confirmed at
T1, accepted at T2, disputed, and reopened. It names the resolution, review
grade, assertion time, review time, and current blocker. Agents submit facts
and evidence. Server rules derive current status. Nothing writes `settled`
directly.

Programme reads lead with ordered cells rather than every attached artifact.
Each row answers code, exact target, current grade, resolution, change time, and
blocker. Work attached to a child programme appears in its ancestors by rule.
A programme change feed reports transitions from a cursor rather than guessing
from edge creation times.

## One lane, with the work queue inside the MCP

The orchestrator already has the required fleet machinery. A temporary
`math-curation` task can use one prompt, a demand command, a model mix, and
`exitWhenDrained`. `pi-orchestrator pause --except math-curation` holds every
other defined lane. Held lanes remain observable but receive no new launches.
Running sessions are deliberately unaffected, so they must finish or be ended
before a strict source freeze begins.

Pi-orchestrator should schedule workers only. It should not know about fronts,
questions, graph components, or curation phases. The math MCP owns the semantic
work queue and hands one packet to each session.

The review queue is the proven concurrency design. `server/src/review.ts` and
`review_queue` in `server/src/index.ts` select and lease work atomically, key
the claimant to the MCP session rather than the shared contributor identity,
expire abandoned leases, and commit a decision with its release. Curation can
reuse that mechanism without reusing `review_claim` itself. Review leases an
adjudication of one contribution. Curation leases a packet that may read many
contributions and writes only typed draft records.

A small migration-only tool set is enough:

- `curation_next` claims and returns one packet;
- `curation_commit` submits a versioned typed proposal;
- `curation_release` returns unfinished work with the exact ambiguity or
  failure encountered;
- `curation_status` supplies queue counts to agents and the orchestrator demand
  probe.

A lease is soft and held by the MCP session or an opaque token returned to it.
Unlike explicit review reclaim, another session under the same contributor key
must not take a live curation lease. A commit checks the lease token and source
revision, writes its typed records, records provenance, and completes the
packet in one transaction. Retries are idempotent. No database transaction
stays open while a model thinks.

## Claim output ownership, not input neighborhoods

Every packet has a deterministic owner key and an exact set of facts it may
write. It may read the whole graph. Discoveries outside its ownership become
follow-up packets rather than competing writes.

Suggested packet owners are:

- `programme:<front id>` owns programme identity, hierarchy, cell ordering,
  stable codes, and direct node membership;
- `question:<problem or conjecture id>` owns the exact target statement,
  scope, and equivalence or duplication findings;
- `result:<root result id>` owns claims extracted from that result bundle,
  required dependencies, and every full or partial resolution it asserts;
- `standalone:<entry id>` handles a theorem, route, computation, source, or
  other claim without a result container;
- `reconcile:<conflict id>` owns a disagreement between proposals.

This permits overlap in what agents read without overlap in what they commit. A
result answering several cells is curated once. A question appearing in two
programmes has one target and two programme memberships. A closure theorem
outside every front still reaches its target through the result packet.

The packet carries source IDs, artifact hashes, the event sequence it was built
from, pointers for fetching the needed bodies and neighborhoods, its ownership
rule, and the exact output shape. It should not dump bodies into the lane
prompt. The agent fetches what it needs through the MCP.

## Independent passes and reconciliation

This work contains mathematical interpretation. Exact coverage and
proof-critical dependence are not safe one-model field conversions.

Simple mechanical placement may need one proposal plus deterministic checks.
Programme structure, dependency sets, and resolution coverage should normally
need two proposals from different MCP sessions. High-consequence closures can
require another independent pass. The queue represents each required attempt
as work and prevents one session from supplying two votes on one packet.

The server normalizes order-insensitive output before comparing proposals.
Agreement admits the typed draft. Disagreement creates a reconciliation packet
for the same lane. An agent that cannot determine a field records `unknown`
and the evidence that prevented a decision. It does not guess to make the
queue smaller.

Deterministic facts stay mechanical. SQL should carry IDs, artifact hashes,
tiers, event times, effective amendments, and explicit links. Models handle
scope, role, dependency, equivalence, and coverage. Reviews and amendments
usually travel as packet context rather than becoming independent semantic
work units.

The same lane can do every phase under one short instruction: claim the next
packet, establish only the facts it owns from source material, commit a
source-backed proposal or an explicit uncertainty, and continue. If the final
conflicts deserve stronger models, change the task's tier mix while retaining
the lane and prompt.

## Unpublished revision and source changes

Agents write accepted packets into one unpublished typed revision in the same
Postgres database. Existing UUIDs and artifacts remain the source material.
Current MCP readers continue to use the existing model until the complete
revision passes validation. A failed pilot can be discarded without repairing
live frontier rows.

At the start of a run, record the maximum event sequence. Every packet carries
that source revision. Pausing other lanes removes most mutations, but public or
interactive writes can still arrive. Either fence ordinary mutation for the
whole run, or turn later events into fresh and dirty packets and use a short
write fence while the final tail drains. The latter is preferable for a run
lasting more than a few hours.

After publication, remove the migration queue, leases, proposal machinery, and
the generic `refresh_state` and direct-membership frontier derivation. Keep the
accepted typed facts, their source references, and ordinary provenance. There
must not be two lasting authorities for current state.

## Run order

1. Finalize target types, output schemas, and database invariants.
2. Import mechanical facts and seed programme and question packets.
3. Admit programme structure and exact targets.
4. Seed result bundles, standalone claims, routes, dependencies, and coverage.
5. Run independent attempts and reconciliation packets.
6. Audit every high-consequence closure and a random sample of ordinary work.
7. Process events after the starting sequence.
8. Fence remaining old writes briefly and drain the final tail.
9. Validate the complete typed revision.
10. Publish it atomically, switch all MCP frontier reads and writes, and delete
    the superseded derivation and migration machinery.

The demand probe must count outstanding attempt slots, including live leases.
The controller already subtracts running lane sessions. Counting only unclaimed
packets would subtract those workers twice and leave capacity unused.

## Validation gates

Publication should fail unless:

- every active front is classified as a programme or explicitly found not to
  be one;
- every active problem and conjecture has a typed target and an intentional
  placement, including standalone questions;
- every active or rejected settling assertion has been inspected;
- programme codes are unique and programme and node hierarchies are acyclic;
- every accepted resolution names exact coverage and a complete dependency
  assessment;
- no unhealthy dependency supports a confirmed or canon resolution;
- every durable typed fact points to source artifacts or events;
- old T2 closures are either represented at the same strength or appear in an
  explicit discrepancy report;
- no uncurated absence is interpreted as `open` or `settled`.

The CI pilot comes first and remains unpublished. One normal read must report:

- A6 was claimed and confirmed at the grade justified by its complete review
  package;
- A5 was claimed, confirmed, rejected, and reopened;
- A3 is a T0 claim with review pending and unhealthy dependencies on rejected
  work.

If the schema cannot express that account directly, stop and revise the schema
before seeding the corpus. A completed queue under the wrong ontology is not
progress.

## Decisions still open

Before implementation, decide:

- whether the first run curates frontier-bearing material only or every result
  bundle in the corpus;
- whether a question outside a named programme gets a standalone programme or
  may remain an ungrouped frontier node;
- the exact boundary between canonical claims and immutable contribution
  artifacts;
- how historical theorem tier, edge tier, and review events become one
  resolution-package grade without inventing review that did not happen;
- which packet kinds require one, two, or more independent proposals;
- whether ordinary public mutation stays open during the bulk pass;
- the model mix for extraction, reconciliation, and final audit.

The fleet should not be asked to choose these rules while populating them. Fix
the ontology and packet contracts first. If work on the CI pilot exposes a
missing distinction, discarding the unpublished revision and changing the
model is the intended outcome.
