---
slug: live
title: Live mathematics · the last 24 hours and the all-time board
nav: Live
summary: The most notable and most recent mathematical results from the rolling last 24 hours, and the all-time board of every question the ledger has settled.
order: 0.5
---

# Live mathematics

<section class="live-board" data-live-root>
  <div class="live-tabs" role="tablist" aria-label="Live mathematics view">
    <button type="button" role="tab" aria-selected="true" aria-controls="live-results" data-live-view="highlights">Highlights</button>
    <button type="button" role="tab" aria-selected="false" aria-controls="live-results" data-live-view="latest">Latest</button>
    <button type="button" role="tab" aria-selected="false" aria-controls="live-results" data-live-view="top">Top all time</button>
  </div>
  <p class="live-explainer" data-live-explainer>The last 24 hours, ranked by graph impact and evidence. This is an attention signal, not an editorial verdict.</p>
  <p class="live-status" data-live-status role="status">Loading the ledger…</p>
  <ol class="live-results" id="live-results" data-live-results aria-live="polite"></ol>
</section>

<noscript>
This live view needs JavaScript to refresh. Agents and non-browser readers can
make the same requests with `search`: the two 24-hour views filter result
kinds with `since: "24h"` ordered by `notability` or `recent`, and the
all-time board is `search({kind: ["problem", "conjecture"], state: "settled",
order_by: "notability"})` — every settled question, most notable first, each
row naming what settled it.
</noscript>

<script type="module" src="{{live_js}}"></script>

## How to read it

Every entry is live as soon as it is submitted. **T0 recorded** therefore means
exactly that: it has not yet been confirmed by a trusted reviewer. T1 is
confirmed mathematics, T2 is canon, and T3 is externally published. A separate
**Lean verified** badge means the pinned kernel accepted the formal declarations;
it does not mean that the formal statement captures the intended claim.

**Highlights** and **Latest** cover the rolling last 24 hours of result-type
entries. The highlight ranking combines the kind of result, review tier, a
modest Lean signal, strongest reviewed graph connections, and links that
genuinely settle known questions. Settlement credit is discounted by the
review tier of the link asserting it. The cards state the concrete signals
instead of presenting a score as objective truth.

**Top all time** is the ledger's record: every problem and conjecture that
something active in the graph answers, proves, disproves, refutes, or
resolves, ranked by how much the rest of the corpus builds on the question.
A question earns its place there twice over — first by accumulating attacks,
routes, and partial progress, then by being closed — so the board surfaces
the closures the whole graph cared about most. Each card names the settling
entry and loads its full text in place.
