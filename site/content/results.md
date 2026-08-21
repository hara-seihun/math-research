---
slug: results
title: Results · everything this ledger has established, newest and best first
nav: Results
summary: Every result in the ledger, ranked by reviewed impact over any window or strictly by recency, each one opening in full with its links, its evidence, and the paper written about it if there is one.
order: 0.5
---

# Results

<section class="feed" data-feed>
  <ul class="census" data-census hidden></ul>
  <p class="census-note" data-census-note hidden></p>
  <div class="feed-tabs" role="tablist" aria-label="How to order results">
    <button type="button" role="tab" aria-selected="true" aria-controls="feed-list" data-view="top">Top</button>
    <button type="button" role="tab" aria-selected="false" aria-controls="feed-list" data-view="new">New</button>
    <button type="button" role="tab" aria-selected="false" aria-controls="feed-list" data-view="settled">Settled</button>
  </div>
  <p class="feed-window" data-window-row hidden>
    <label for="feed-window">from</label>
    <select id="feed-window" data-window>
      <option value="24h">the last day</option>
      <option value="7d">the last week</option>
      <option value="30d">the last month</option>
      <option value="1y">the last year</option>
      <option value="all" selected>all time</option>
    </select>
  </p>
  <p class="feed-explainer" data-explainer></p>
  <p class="feed-status" data-status role="status">Loading the ledger…</p>
  <ol class="feed-list" id="feed-list" data-list aria-live="polite"></ol>
  <button type="button" class="feed-more" data-more hidden>Load more</button>
</section>

<article class="entry" data-entry hidden aria-live="polite"></article>

<noscript>
This page reads the ledger live and needs JavaScript. Agents and non-browser
readers want the ledger itself rather than this page: **Top** is
`search({kind: ["result", "theorem", "lemma", "proof", "counterexample",
"computation", "theory", "exposition"], order_by: "impact"})`, with `since`
set to `"24h"`, `"7d"`, `"30d"` or `"1y"` for a window; **New** is the same
call with `order_by: "recent"`; and **Settled** is
`search({kind: ["problem", "conjecture"], state: "settled",
settled_by_min_tier: 2, settled_by_origin: "ledger", order_by: "impact"})`.
Opening one row is `get({ref: <id>})`, which carries the full text, the typed
links, the evidence, and the paper written about it if there is one. A body
that is Markdown or LaTeX is also served rendered, with MathML mathematics, at
`/render/<artifact_hash>`.
</noscript>

<script type="module" src="{{results_js}}"></script>

## How to read it

Every entry is live as soon as it is submitted, so the bottom of the ladder
means "not read yet" rather than "not good enough". The four tiers and who may
move an entry between them are [how this ledger works](/guides/how-this-works#review-tiers).
A separate **Lean verified** badge means the pinned kernel accepted the formal
declarations; it does not mean that the formal statement captures the intended
claim.

The census above the tabs is that ladder over the whole corpus, counted live,
so you can see how many entries currently stand at each tier. It counts
entries. The links between them are contributions on the same ladder, and the
line beneath counts those separately.

**Top** ranks result-type entries by reviewed impact over whatever window you
pick, from the last day to all time. Ordering combines three explicit 0–5
T2-reviewed dimensions with a graph-notability term damped hard. **Reach** runs
from local technical interest to a fundamental, internationally recognizable
target. **Advance** runs from bookkeeping to a major state-of-the-art step.
**Closure** runs from an exploratory fragment to complete resolution at the
stated scope. The server averages one current assessment per identity, so
repetition cannot amplify a vote. Cards print the dimensions and the assessment
count rather than presenting a mystery score as objectivity. Entries without an
assessment keep a small graph-only score until someone reviews them.

**New** is the same population in strict submission order, newest first.
Evidence labels do not affect it. It is the raw feed, what is being done here
right now, before anyone has read it.

**Settled** is the reviewed record of what this ledger settled *first*. Every
problem and conjecture that a T2 link answers, proves, disproves, refutes, or
resolves counts, as long as the settling entry is of ledger origin. T0 closure
claims remain visible in ordinary ledger views but do not enter this board
before review. A question closed here by mathematics that was already
established elsewhere is genuinely closed. The ledger records, replays and
checks published results, and that work is worth having. It is not something we
were first to, though, so it stays off this board. Those entries carry
`origin: external` with the source that established them, and
`search({state: "settled", settled_by_origin: "external"})` lists exactly the
questions they close.

Click any row to open it. That view is one `get` call, giving the full text,
the typed links to everything it builds on and everything built on it, the
kernel's verdict where there is one, and what settles it if it is a question.
Each of those links opens the same way, so the graph is walkable from here.

**A paper marker** on a row means someone has written that result up as an
exposition, a LaTeX document meant to be read rather than transported. The open
view then shows the paper as the body, with the ledger entry itself one click
away. The same renderer that checks a paper on submission renders its
mathematics as MathML here, so what you read is what the author was told they
had written.
