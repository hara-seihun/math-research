# TODO

## Replace the document graph with a typed frontier model

Deferred by Hara on 2026-08-24 for a decision on 2026-08-25 or 2026-08-26. No
implementation has started.

The full diagnosis, live corpus census, target model, in-place swarm design,
validation gates, CI acceptance case, and unresolved decisions are in
[`docs/typed-frontier-curation.md`](docs/typed-frontier-curation.md). Read it
before changing the schema or lane definitions.

The current model lets an unreviewed settling edge mark a cell `settled`,
reviews a theorem separately from its claim of exact coverage, has no durable
settlement transitions, and treats programmes as flat collections of generic
contributions. The CI programme exposes all of these at once: A6 is confirmed
mathematics with separately unreviewed answerhood, A5 was rejected and
reopened, and A3 is an unreviewed closure relying in prose on rejected work.

The likely implementation shape is one temporary `math-curation` orchestrator
lane backed by a session-leased work queue in the MCP. Agents claim deterministic
semantic packets such as programmes, questions, and whole result bundles,
write source-backed proposals into one unpublished typed revision, and run
independent reconciliation passes. The orchestrator already provides demand,
`exitWhenDrained`, shared prompts, model mixes, and `pause --except`; it should
schedule workers and know nothing about graph partitioning.

Settle the target types and packet ownership rules before launching the fleet.
Start with an unpublished CI pilot. If one ordinary read cannot distinguish A6
claimed and confirmed, A5 rejected and reopened, and A3 claimed at T0 with
unhealthy dependencies, revise the model rather than seeding the corpus.
Publication is complete only when all frontier reads and future write doors use
the typed model and the generic `refresh_state`, direct-membership derivation,
and temporary migration machinery are gone.

## Make the onboarding site nicer (Hara)

The site (`site/`) is a first pass: content, structure, and plumbing are in
place and deployed at <https://lemma.ing>, but the visual design is
deliberately plain and awaiting Hara's edits. Whatever changes, keep the
invariants that make it work for agents: a Markdown twin of every page, the
maximally permissive `robots.txt`, `llms.txt`/`llms-full.txt`, and the
build-time gates (broken internal links and documented calls the server would
reject both fail the build).

Sources are `site/content/*.md` plus the repo's `guides/`; `site/build.ts`
generates everything and `site/assets/style.css` is the whole look. Preview
with `bun run build.ts` in `site/`; ship with `tools/deploy.sh --site`, which
touches no service and is safe while Lean checks are in flight.

## Tune the discovery policy against real corpus behaviour

The notability weights and the topic taxonomy now live in the database and are
tunable live over the MCP by a trusted operator. Query `q_config` and
`q_topic_rules` for the current values, and use `set_tuning` to change them
(deep-merges weights and recomputes notability; replaces topic rules and
reclassifies the corpus).
No deploy needed.

Initial calibration, 2026-08-21: parallel assertions of one relation now reduce
to their strongest active edge; settlement credit uses only actual settling
relations and is discounted by the settling edge's tier; `serves` no longer
inflates resolution impact; and the Lean signal fell from 2.0 to 0.75 so
formalization is evidence rather than a substitute for scope. The `/results`
page makes the ranking and its concrete graph signals directly visible over
any window.

Still to do, as empirical tuning while that feed accumulates examples:

- **Notability weights** (`kind`, `rel`, `tier`, `edge_tier`, `settle`, `lean`):
  compare `search({order_by:'notability'})` and `/results` against trusted
  pairwise judgments, especially for dense campaigns and hub problems. Decide
  whether `front`/`edge` kinds should stay at 0 and whether the remaining
  relation weights preserve broad results over narrow but heavily linked ones.
- **Topic taxonomy** (`topic_rule` patterns): ~49% of the corpus is untagged, so
  decide whether that's fine (terse lemma statements) or the patterns need
  broadening; check for over/under-triggering topics and add missing subject
  areas. Patterns are POSIX/advanced regex matched against lowercased text.
- Re-run against a sample of "find the interesting stuff" queries and adjust.

Do this interactively with the operator via `set_tuning`, not as a code change.
