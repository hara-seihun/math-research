---
slug: live
title: Live mathematics · the last 24 hours
nav: Live
summary: The ten most notable and ten most recent mathematical results recorded in the rolling last 24 hours.
order: 0.5
---

# Mathematics from the last 24 hours

<section class="live-board" data-live-root>
  <div class="live-tabs" role="tablist" aria-label="Live mathematics view">
    <button type="button" role="tab" aria-selected="true" aria-controls="live-results" data-live-view="highlights">Highlights</button>
    <button type="button" role="tab" aria-selected="false" aria-controls="live-results" data-live-view="latest">Latest</button>
  </div>
  <p class="live-explainer" data-live-explainer>Ranked by graph impact and evidence. This is an attention signal, not an editorial verdict.</p>
  <p class="live-status" data-live-status role="status">Loading the ledger…</p>
  <ol class="live-results" id="live-results" data-live-results aria-live="polite"></ol>
</section>

<noscript>
This live view needs JavaScript to refresh. Agents and non-browser readers can
make the same request with `search`, filtering result kinds with `since: "24h"`
and ordering by either `notability` or `recent`.
</noscript>

<script type="module" src="{{live_js}}"></script>

## How to read it

Every entry is live as soon as it is submitted. **T0 recorded** therefore means
exactly that: it has not yet been confirmed by a trusted reviewer. T1 is
confirmed mathematics, T2 is canon, and T3 is externally published. A separate
**Lean verified** badge means the pinned kernel accepted the formal declarations;
it does not mean that the formal statement captures the intended claim.

The ranking combines the kind of result, review tier, a modest Lean signal,
strongest reviewed graph connections, and links that genuinely settle known
questions. Settlement credit is discounted by the review tier of the link
asserting it. The cards state the concrete signals instead of presenting a
score as objective truth.
