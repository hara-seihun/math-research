# What our research agents need

Opened 2026-08-20, after reading 46 orchestrator run transcripts end to end.
Standing math lane launches are **paused** (`pi-orchestrator pause`) while this
is decided; running agents were left to drain. Nothing here is built yet.

This file is the plan. Three things are wrong, in the order they should be
fixed. Two are this server's job; the first is the orchestrator's, and it comes
first because the other two are wasted on an agent that quits after seven
minutes.

**Status 2026-08-20:** §1 is done as a prompt rewrite and §2 is built and
live; §3 is untouched. Launches remain paused until a supervised wave shows
whether session depth actually changed, and the numbers below are the baseline to
re-measure against.

## What the transcripts showed

Agents are not being cut off. No compaction ever fired, there is no turn cap
and no timeout. They quit.

- Median frontier run **6.9 minutes**; **86% of the session precedes the first
  submission**; the run ends **35 seconds after the last submit**. There is no
  second act.
- **81% of everything an agent reads is ledger JSON.** 1121 reads (416 `get`,
  304 `search`, 158 `frontier`) against 57 writes, with a median of 22 reads
  before work starts. 28% of read payloads exceeded the 8 KB transcript cap, so
  the true volume is larger.
- The mathematics happens almost entirely in-head: 132 python and 17 GAP calls
  across 46 runs, on a *Cayley graph* campaign, where enumerating small groups
  is the natural first move.
- 86 `lean`/`lake` calls were agents **hunting for a Mathlib installation**.
  `lean` and `lake` are on PATH; there is no project. They crawl the
  filesystem, land on leftover scratch trees in `/tmp` from unrelated work, or
  hit `unknown module prefix 'Mathlib'` and give up. 2 of the last 50 fleet
  submissions are `lean_verified`.
- Output is mostly bookkeeping: of 100 consecutive fleet submissions, **84 were
  edges**, 9 theorems, 3 problems, 1 counterexample.

The thinking says the rest out loud. One agent identified the substantial
target, then: *"Solving primitive translation canonization would complete the
proof, but that is likely too much for one session"*, and twenty steps later
chose a smaller one because it was *"a fresh residual with no trail"*. Another
announced *"I understand the front and am ready to begin working"* at event 124
of 149.

That preference is a pump, and the graph records what it pumped, by the minute:

```
cgi-primitive-translation-canonization                        (Aug 18)
  ← refines — Primitive elementary-abelian translation canonization  (04:18)
  ← refines — Canonization of Hamming-frame coherent refinements     (04:28)
  ← refines — Fixed-odd-prime monomial canonization of Hamming-frame (04:38)
```

Three levels of narrowing in twenty minutes, each new shard instantly the
freshest and least-trailed target for the next agent, with a `duplicates` edge
already recorded between two independently produced shards. The three
most-attacked targets of that window were all created that morning by the fleet
itself; the root problems from Aug 12 were attacked less.

## 1. The lane contract (orchestrator)

**Owner:** `pi-orchestrator` task definitions, see
[`../../pi-orchestrator/README.md`](../../pi-orchestrator/README.md) and the
handbook's [standing math lanes](../../../machine/pi.md).

The current prompt is satisfied by one submission, so agents produce one and
leave. Its collision-avoidance rule ("prefer the least-attacked one") steers
them away from the hard central problems, which always carry trails because
everyone works them, and toward freshly minted shards, which carry none. The
demand probe then pays six units of funded work per shard, so the loop finances
its own shallowness.

The decommissioned predecessor solved this. Its artifacts were retired to
external cold storage on 2026-08-21 and survive as provenance at
`/mnt/cold-storage/projects-research/source/` (read-only, and never restored to
the main system without a direct ask from Hara, see
[`AGENTS.md`](../../../AGENTS.md#external-cold-storage)); the doctrine itself
lives on in [`guides/attack.md`](../guides/attack.md) and
[`~/memory/frontier-math-one-shot-record.md`](../../../memory/frontier-math-one-shot-record.md).
Worth reading before rewriting anything:

- `tasks/frontier.md`, *"Publishing a partial theorem is not terminal: return
  immediately to the exact global blocker and continue"*; single-flight lease;
  *"Do not call `task_complete` while the exact scope is open and another
  attack on its global blocker is available."*
- `docs/ATTACK.md`, the **anti-ladder rule** (*"Never replace the cell or
  obligation by the next finite slice… A bounded slice is proof material, not
  the answer"*), *"Do not stop at the first publishable fact"*, and the naming
  of why models flinch: *"a census or taxonomy always 'succeeds', so it
  functions as deliverable insurance"* and *"the flinch is about scope rather
  than about the target."*
- `tools/dispatch.py`, where work is claimed and its context packet generated **before**
  the agent starts, so *"the session's first tokens go to mathematics instead
  of orientation"*.
- Doctrine bound structurally rather than by prompt curation: the lease grant
  printed a `DOCTRINE=` pointer and a test failed the pipeline for any research
  prompt that did not require it.
- An honest-failure vocabulary (`advance`/`failed`/`solved`/`no-solution`) with
  attempt reports naming the first unsupported blocker. 283 of 566 Cayley cell
  leases ended `failed`, and that was fine. Our lane's only exit is "submit
  something", so an agent that cannot crack the problem must manufacture a
  publishable crumb to feel productive.

Durations bear it out: old `cayley-ci-cells` leases ran a median 10.6 min, p75
21.4, p90 32.4, with a deep tail (`cayley-ci-alignment` p90 was 120 min).
Ours: median 6.9, max 20.6, half the median and no tail at all.

Open questions: whether depth is enforced by prompt, by a completion check
command, or by a host-side continuation policy; how to keep collision avoidance
without making freshness the selection criterion; whether shard-creation should
still fund demand.

**Done 2026-08-20, by prompt.** All three lane prompts were rewritten
(`pi-orchestrator task set <id> --prompt …`, which now merges over the stored
row instead of replacing it). `math-frontier` selects the most central
attackable problem and spreads by *angle* rather than by freshness, is
forbidden from replacing its target with a narrower slice to manufacture a
deliverable, is told that publishing a partial result is not terminal and to
return to the exact blocker, and is given an honest-failure exit so a failed
attack no longer needs a publishable crumb to feel productive. All three name
`check_lean` and `fast-math`.

Still open here. Depth is only asked for, not enforced, and nothing structurally
prevents `task_complete` at the first submission the way the predecessor's
lease did; and the demand probe still pays six units per active CI problem, so
minting a shard still funds work on it. Both need the next wave's evidence.

**Obstruction custody repaired 2026-08-21.** The first post-resume audit found
816 submissions, 445 trail notes, and 190 obstruction-like trail notes, but
zero native `route` contributions and zero entries carrying
`first_unsupported`; every durable route in the corpus still came from the
Projects Research import. The lane's "recorded trail is productive" exit had
made the diary sufficient. The MCP and lane contract now distinguish the two:
tentative chronology stays in a trail, while every established obstruction is
submitted as `kind: route` with `state`, typed `first_unsupported`, and an
`attacks` edge before the trail closes. Trail closure now requires an explicit
outcome; `blocked` and `refuted` are rejected unless the close attaches a
durable route, while `no-result` explicitly says no claim emerged. This is the
shape consumed by `frontier.where_routes_stall`.

## 2. Lean as a server capability

**Owner:** this server (`server/`, `lean/`, the verifier daemon).

The kernel checker already exists, is pinned to the Lean and Mathlib revisions in `lean/`, audits
axioms, and is trusted, which is what `lean_verified` means. It is only reachable
**by submitting**, which forces a permanent, public, attributed artifact into
existence in order to run a check that should be throwaway. That single fact
plausibly explains most of the missing formalization, and
[`../guides/lean.md`](../guides/lean.md) currently answers the problem by
telling the reader to go build their own Mathlib.

Expose the checker as a tool: send Lean source, get back the verdict, errors
with line numbers, the declarations proven, and the axioms each rests on, with
no contribution created. Formalization then becomes iterative inside a session,
which is the only way it ever works.

Why server-side rather than a Mathlib checkout per agent: a cold `lake exe
cache get` is minutes out of a session that currently lasts seven; N agents
means N multi-gigabyte trees drifting independently; and a local toolchain
disagrees with the authority that actually stamps `lean_verified`.

- **Caching is the whole game and it is free.** A check is a pure function of
  (source, toolchain, Mathlib revision). Content-address the source and the
  same lemma checked by forty agents costs one kernel run; a warm environment
  amortizes the import cost that dominates a cold check.
- **It changes what an agent can attempt.** Today "verify ruthlessly" means the
  agent re-reads its own argument. With a checker in the loop the hostile
  standard becomes mechanical.
- **It is a genuine public draw.** Free, zero-setup, no-signup Lean with
  Mathlib pinned and warm is scarce; setup cost is the single biggest barrier
  to casual Lean use, and every other agent on the internet has exactly the
  problem ours have. It fits the server's posture, since you point a client at it
  with nothing to configure, and an agent that arrives for a free proof checker is
  one step from submitting what it proved.

Open question, and the real one: this is a public endpoint running a heavy
process that can be told to loop forever. Limits, timeouts, concurrency, and
abuse are an actual external boundary and need designing rather than assuming.

**Built 2026-08-20.** `check_lean` takes Lean source and returns the kernel's
verdict, either errors with line numbers or the exact statements proven with the
axioms each rests on, and creates nothing. `sorry` is allowed and reported
(a proof resting on `sorryAx` reads as `incomplete`, not `passed`), because a
check you can only run on a finished proof is an exam, not a proof assistant.

Caching landed as the design above: one `lean_check` table keyed by
`sha256(source)`, with the tool and the submission path as its two callers.
Submitting source you already checked resolves from cache without touching the
kernel. Policy stayed on the submission path only, so unsound tokens are refused
before they cost a kernel slot, and foreign axioms fail the badge.

Measured on the live guest: ~6 s for a small check against warm Mathlib,
~0.2 s cached. The external boundary is currently three limits, 64 KiB of
source, 200 checks per identity per hour, 32 queued checks before the server
sheds load, plus the existing 10-minute compile timeout and the runner's two
lanes under a 16 GiB ceiling. Capacity, not the API, is what will bind first:
the predecessor's `leancheck/daemon.py` (a persistent REPL pool with a pickled
warm environment and per-worker RSS caps, and a comment recording that 6 lanes
× 8 GiB OOM-killed itself at a 38 GiB ceiling) is the technique to carry over
if the queue starts backing up.

## Follow-up audit: the workbench, 2026-08-22

The resumed wave no longer quits after one result: 120 recent runs contained
108,430 events and many live sessions had already crossed a thousand events.
That exposed a different class of waste. Agents were doing sustained research,
but repeatedly paid for a workbench that looked complete and was not.

Across retained transcripts, direct Python use of the published kernel failed
with `No module named fast_math` 72 times. The conventional `/usr/bin/time`
path failed throughout benchmark scripts, Boost headers were absent, and
installed FLINT and GMP headers or libraries were not discoverable by a bare
compiler or `pkg-config`. One provenance session also had to abandon its
asynchronous fetcher because `aiohttp` was absent. The host environment now
makes these ordinary operations work directly: every system Python entry point
imports the live `/srv/pi/fast-math/current/python`, the global compiler and
`pkg-config` wrappers see the declared headers and libraries, Boost and
`aiohttp` are installed, and the observed `time` path is a declarative link.
The fix is in `/etc/nixos/configuration.nix`, not in a session-local shell.

The same audit found server friction rather than mathematical difficulty:

- agents shortened UUIDs to the eight-character handles used in prose, then
  had to search again because read doors required all 36 characters;
- `query` mistook semicolons inside SQL strings and regular expressions for a
  second statement;
- every rolling server deployment reset a small burst of live MCP calls. The
  failures clustered exactly at deployment timestamps and appeared to agents
  only as `fetch failed`;
- Lean work stalled to recover argument order or source examples from a broad
  declaration search.

Read doors now resolve unique UUID prefixes, SQL statement detection follows
Postgres quoting, and each HTTP instance drains in-flight requests before a
rolling restart. Lean has three distinct fast paths: `lean_info` for one exact
signature, `lean_grep` for actual Mathlib and MathlibPlus source, and
`check_lean.declaration_info` for signatures named by a failed elaboration.
These are workbench repairs, not prompt advice: the successful route is now the
obvious route an agent was already trying to take.

## 3. Literature review

**Owner:** this server (a `source` contribution kind), plus whichever lane owns
discovery.

An agent working a problem cannot ask what the world already knows. Its only
window is the ledger, which contains only what this fleet has written. The
transcripts show the consequence: Muzychuk, Babai, and Leung–Man cited from
memory with no source consulted, and an agent reasoning about what a 1979
Miller result *probably* says.

The predecessor gave discovery a dedicated standing lane, recorded findings as
typed external records (`claims-solution`, `baseline`, `prior-art`), and then
forbade every other lane from open-ended searching, *"do not invoke Exa Search
or independently repeat its literature review, though you may fetch an
already-known source locator directly"*, with two rules worth keeping
verbatim: **external prose is never itself proof authority, verify anything you
import**, and an open `claims-solution` on your target is a duplication
warning, never permission to import prose as a theorem.

Keep that shape, move the storage into the ledger: a first-class `source`
contribution (arXiv id, DOI, locator) on the same T0–T3 ladder, linked to
mathematics by typed edges (`states`, `proves`, `baseline-for`,
`claims-solution`, `contradicts`). "What is known about this problem" then
becomes `context(id)`, a query agents already run, instead of a skill they
must remember to invoke. Sources should be **cheap to add and expensive to
trust**: T0 means "someone says this is relevant", and promotion is evidence
about the literature, never about the mathematics.

Retrieval is not the hard part, since Exa is authenticated on this box and arXiv has
an open API. Custody is: who fetches, where it lands, and how the next agent
finds it without re-fetching. Fetching behind an MCP tool lets the server
extract and cache once, exactly like the Lean case.

**Started 2026-08-21.** The standing `math-provenance` orchestrator lane owns
this audit with share 1 and constant demand 1, so only one source-reading
session works it at a time. The existing generic contribution model already
accepts `kind: source` objects and typed links. The lane verifies primary
sources, creates or reuses those objects, adds source and dependency links,
and calls `set_origin` when an entry's headline claim was established
elsewhere first. A new claim that depends heavily on prior work keeps ledger
origin and records the dependence through its links and review. This gives the
corpus durable provenance now. A server-side source fetch and cache is still
unbuilt.

## Sequence

The lane contract and Lean checker landed first. The provenance lane now
supplies literature custody through generic source contributions and typed
links. A server-side
fetch and cache remains the next literature step if repeated retrieval becomes
a measured cost. That order mattered because free Lean or source retrieval
handed to an agent that quit after seven minutes would only have produced
faster shallow work.
