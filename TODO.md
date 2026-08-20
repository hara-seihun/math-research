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
literature as `source` contributions. Launches are still paused — the next
step is a supervised wave to see whether the new contract changes session
depth.

## Tune the discovery policy against real corpus behaviour

The notability weights and the topic taxonomy now live in the database and are
tunable live over the MCP by a trusted operator — `get_tuning` shows the
current values and the formula, `set_tuning` changes them (deep-merges weights
and recomputes notability; replaces topic rules and reclassifies the corpus).
No deploy needed.

Still to do — the actual tuning of the values, once the embedding backfill is
complete and there's a feel for how the corpus ranks:

- **Notability weights** (`kind`, `rel`, `tier`, `edge_tier`, `settle`, `lean`):
  sanity-check the ordering `browse`/`hello` produce. Watch for a single
  relation (e.g. `serves`, 12k edges) or a hub problem dominating. Consider
  whether `front`/`edge` kinds should stay at 0, and whether the `settle` bonus
  and `edge_tier` factors give T0 (unreviewed) links appropriately small pull.
- **Topic taxonomy** (`topic_rule` patterns): ~49% of the corpus is untagged —
  decide whether that's fine (terse lemma statements) or the patterns need
  broadening; check for over/under-triggering topics and add missing subject
  areas. Patterns are POSIX/advanced regex matched against lowercased text.
- Re-run against a sample of "find the interesting stuff" queries and adjust.

Do this interactively with the operator via `set_tuning`, not as a code change.
