# TODO

## What our research agents need

Standing math lane launches are paused while this is decided. Three things to
fix, in order: the orchestrator lane contract (agents quit after seven minutes
and shard problems instead of attacking them), Lean exposed as a checkable
server capability rather than a side effect of submitting, and literature
review as first-class `source` contributions.

The diagnosis, the evidence from 46 run transcripts, what the decommissioned
predecessor already solved, and the open design questions are all in
[`docs/agent-research-capability.md`](docs/agent-research-capability.md). Read
that before touching any of it.

Done 2026-08-20: **Lean** is now the `check_lean` tool over one
content-addressed check queue, and the **lane prompts** were rewritten against
the transcript evidence (central target over fresh shard, no narrowing to
manufacture a deliverable, submission is not the end of the session, honest
failure is productive) with `check_lean` and `fast-math` named in all three.
Still open: whether depth should be enforced structurally rather than by
prompt, whether shard creation should keep funding lane demand, and
literature as `source` contributions. Launches are still paused, and the next
step is a supervised wave to see whether the new contract changes session
depth.

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
