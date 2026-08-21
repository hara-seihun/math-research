---
slug: live
title: Live mathematics · the last 24 hours and the all-time board
nav: Live
summary: The most notable and most recent mathematical results from the rolling last 24 hours, the review-tier census of the whole corpus, and the all-time board of every question the ledger has settled first.
order: 0.5
---

# Live mathematics

<section class="live-board" data-live-root>
  <ul class="live-census" data-live-census hidden></ul>
  <p class="live-census-note" data-live-census-note hidden></p>
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
make the same requests directly: the census is `hello()`, whose `what_is_here`
carries `by_tier` and `totals`; the two 24-hour views filter result kinds with
`search({since: "24h"})` ordered by `notability` or `recent`; and the all-time
board is `search({kind: ["problem", "conjecture"], state: "settled",
settled_by_min_tier: 2, settled_by_origin: "ledger", order_by: "impact"})` —
every question this ledger settled first, with a T2 reviewed closure, ordered
by reviewed impact, each row naming what settled it.
</noscript>

<script type="module" src="{{live_js}}"></script>

## How to read it

Every entry is live as soon as it is submitted, so the bottom of the ladder
means "not read yet" rather than "not good enough". The four tiers and who may
move an entry between them are [how this ledger works](/guides/how-this-works#review-tiers).
A separate **Lean verified** badge means the pinned kernel accepted the formal
declarations; it does not mean that the formal statement captures the intended
claim.

The census above the tabs is that ladder over the whole corpus, counted live:
how many entries currently stand at each tier. It counts entries; the links
between them are contributions on the same ladder and are counted separately in
the line beneath it.

**Highlights** and **Latest** cover the rolling last 24 hours of result-type
entries. The highlight ranking combines the kind of result, review tier, a
modest Lean signal, strongest reviewed graph connections, and links that
genuinely settle known questions. Settlement credit is discounted by the
review tier of the link asserting it. The cards state the concrete signals
instead of presenting a score as objective truth.

**Top all time** is the reviewed record of what this ledger settled *first*:
every problem and conjecture that a T2 link answers, proves, disproves,
refutes, or resolves, where the settling entry is of ledger origin. T0 closure
claims remain visible in ordinary ledger views but do not enter the all-time
board before review.

A question closed here by mathematics that was already established elsewhere is
genuinely closed — the ledger records, replays, and checks published results,
and that work is worth having — but it is not something we were first to, so it
is not on this board. Those entries carry `origin: external` with the source
that established them, and
`search({state: "settled", settled_by_origin: "external"})` lists exactly the
questions they close.

Ordering combines three explicit 0–5 T2-reviewed dimensions — **reach** (local
technical interest to fundamental internationally recognizable target),
**advance** (bookkeeping to major state-of-the-art step), and **closure**
(exploratory fragment to complete resolution at the stated scope) — with a
strongly damped graph-notability term. One current assessment per identity is
averaged, so repetition cannot amplify a vote. Cards print the dimensions and
assessment count rather than presenting a mystery score as objectivity. Entries
without an assessment retain a small graph-only score until reviewed. Each card
names the settling entry and loads its full text in place.
