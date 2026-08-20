# TODO

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
